// xbench-android: reads an Android device's screen for the X Bench host. Runs on the device through
// app_process, the way scrcpy's server does, and keeps one UiAutomation connection while it is used. A read of
// the screen's tree waits for the screen to idle, for at most the time the host gives it.
//
// Usage: CLASSPATH=/data/local/tmp/xbench-android.jar app_process / xbench.Helper
// stdin: one JSON request per line: {"id": 1, "op": "tree", "idleMs": 2000} for the tree once the screen has idled,
// or after idleMs if it keeps changing, {"id": 2, "op": "shot", "scale": 2.625,
// "quality": 70} for a JPEG at one pixel per scale screen pixels, or {"id": 3, "op": "display"}.
// stdout: one JSON reply per line, {"id", "ok", ...} with xml, jpeg or the display's width, height, rotation
// and density, or {"id", "ok": false, "error"}. The first line is {"event": "ready"}.

package xbench;

import android.app.UiAutomation;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.graphics.Bitmap;
import android.graphics.Rect;
import android.os.HandlerThread;
import android.os.Looper;
import android.util.Base64;
import android.view.accessibility.AccessibilityNodeInfo;
import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.util.concurrent.TimeoutException;
import org.json.JSONObject;

public final class Helper {
  // UiAutomation lets go after this long without a request, so instrumentation tests can take it.
  private static final long IDLE_MS = 60_000;
  // The screen counts as idle after this long without an accessibility event.
  private static final long QUIET_MS = 300;

  private final PrintStream out;
  private final HandlerThread thread = new HandlerThread("xbench-android");
  private UiAutomation automation;
  private long lastUse;

  private Helper(PrintStream out) {
    this.out = out;
  }

  public static void main(String[] args) throws Exception {
    PrintStream out = new PrintStream(new java.io.FileOutputStream(java.io.FileDescriptor.out), false, "UTF-8");
    // Anything the framework prints must not mix with the replies.
    System.setOut(System.err);
    Looper.prepareMainLooper();
    Helper helper = new Helper(out);
    Thread requests = new Thread(() -> {
      try {
        helper.run();
      } catch (Throwable e) {
        e.printStackTrace();
      }
      System.exit(0);
    });
    requests.start();
    // The accessibility client hands work to the main thread's looper.
    Looper.loop();
  }

  private void run() throws Exception {
    thread.start();
    Thread idle = new Thread(() -> {
      while (true) {
        try {
          Thread.sleep(5_000);
        } catch (InterruptedException e) {
          return;
        }
        synchronized (this) {
          if (automation != null && System.currentTimeMillis() - lastUse > IDLE_MS) disconnect();
        }
      }
    });
    idle.setDaemon(true);
    idle.start();
    reply(new JSONObject().put("event", "ready"));
    BufferedReader in = new BufferedReader(new InputStreamReader(System.in, "UTF-8"));
    for (String line = in.readLine(); line != null; line = in.readLine()) {
      if (line.trim().isEmpty()) continue;
      JSONObject request;
      try {
        request = new JSONObject(line);
      } catch (Exception e) {
        continue;
      }
      JSONObject answer = new JSONObject().put("id", request.optLong("id"));
      try {
        synchronized (this) {
          handle(request, answer);
        }
        answer.put("ok", true);
      } catch (Throwable e) {
        answer.put("ok", false).put("error", String.valueOf(e.getMessage() != null ? e.getMessage() : e));
      }
      reply(answer);
    }
    synchronized (this) {
      disconnect();
    }
  }

  private void handle(JSONObject request, JSONObject answer) throws Exception {
    String op = request.optString("op");
    if (op.equals("tree")) {
      answer.put("xml", tree(request.optLong("idleMs", 0)));
    } else if (op.equals("shot")) {
      shot(request.optDouble("scale", 1), request.optInt("quality", 70), answer);
    } else if (op.equals("display")) {
      display(answer);
    } else {
      throw new IllegalArgumentException("Unknown op " + op);
    }
  }

  private void reply(JSONObject object) {
    synchronized (out) {
      out.print(object.toString());
      out.print('\n');
      out.flush();
    }
  }

  private UiAutomation automation() throws Exception {
    lastUse = System.currentTimeMillis();
    if (automation != null) return automation;
    Class<?> connectionClass = Class.forName("android.app.UiAutomationConnection");
    Constructor<?> makeConnection = connectionClass.getDeclaredConstructor();
    makeConnection.setAccessible(true);
    Object connection = makeConnection.newInstance();
    Class<?> connectionInterface = Class.forName("android.app.IUiAutomationConnection");
    Constructor<UiAutomation> make = UiAutomation.class.getDeclaredConstructor(Looper.class, connectionInterface);
    make.setAccessible(true);
    UiAutomation made = make.newInstance(thread.getLooper(), connection);
    Method connect = UiAutomation.class.getDeclaredMethod("connect", int.class);
    connect.setAccessible(true);
    connect.invoke(made, UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
    AccessibilityServiceInfo info = made.getServiceInfo();
    if (info != null) {
      info.flags |= AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS | AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS;
      made.setServiceInfo(info);
    }
    automation = made;
    return made;
  }

  private void disconnect() {
    if (automation == null) return;
    try {
      Method method = UiAutomation.class.getDeclaredMethod("disconnect");
      method.setAccessible(true);
      method.invoke(automation);
    } catch (Throwable ignored) {
      // The process ends soon after, which drops the connection too.
    }
    automation = null;
  }

  // The active window as uiautomator dump writes it. Right after connecting, the window may not be there yet.
  private String tree(long idleMs) throws Exception {
    UiAutomation ui = automation();
    if (idleMs > 0) {
      // waitForIdle returns at once before a change's first event, so the quiet time also counts from the request.
      long first = Math.min(QUIET_MS, idleMs);
      Thread.sleep(first);
      try {
        if (idleMs > first) ui.waitForIdle(QUIET_MS, idleMs - first);
      } catch (TimeoutException stillChanging) {
        // A screen that never idles still gets read.
      }
    }
    AccessibilityNodeInfo root = null;
    for (int attempt = 0; attempt < 60 && root == null; attempt++) {
      root = ui.getRootInActiveWindow();
      if (root == null) Thread.sleep(50);
    }
    if (root == null) throw new IllegalStateException("No window is active on the screen.");
    Rect screen = new Rect();
    root.getBoundsInScreen(screen);
    StringBuilder xml = new StringBuilder(64 * 1024);
    xml.append("<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation=\"0\">");
    node(xml, root, 0, screen, 0);
    xml.append("</hierarchy>");
    return xml.toString();
  }

  private static void node(StringBuilder xml, AccessibilityNodeInfo node, int index, Rect screen, int depth) {
    Rect bounds = new Rect();
    node.getBoundsInScreen(bounds);
    if (!bounds.intersect(screen)) bounds.setEmpty();
    xml.append("<node index=\"").append(index).append('"');
    attr(xml, "text", node.getText());
    attr(xml, "resource-id", node.getViewIdResourceName());
    attr(xml, "class", node.getClassName());
    attr(xml, "package", node.getPackageName());
    attr(xml, "content-desc", node.getContentDescription());
    flag(xml, "checkable", node.isCheckable());
    flag(xml, "checked", node.isChecked());
    flag(xml, "clickable", node.isClickable());
    flag(xml, "enabled", node.isEnabled());
    flag(xml, "focusable", node.isFocusable());
    flag(xml, "focused", node.isFocused());
    flag(xml, "scrollable", node.isScrollable());
    flag(xml, "long-clickable", node.isLongClickable());
    flag(xml, "password", node.isPassword());
    flag(xml, "selected", node.isSelected());
    xml.append(" bounds=\"[").append(bounds.left).append(',').append(bounds.top).append("][").append(bounds.right).append(',').append(bounds.bottom).append("]\"");
    attr(xml, "hint", node.getHintText());
    xml.append('>');
    int count = depth < 60 ? node.getChildCount() : 0;
    int shown = 0;
    for (int i = 0; i < count; i++) {
      AccessibilityNodeInfo child = node.getChild(i);
      if (child == null) continue;
      if (child.isVisibleToUser()) node(xml, child, shown++, screen, depth + 1);
    }
    xml.append("</node>");
  }

  private static void attr(StringBuilder xml, String name, CharSequence value) {
    xml.append(' ').append(name).append("=\"");
    if (value != null) {
      for (int i = 0; i < value.length(); i++) {
        char c = value.charAt(i);
        if (c == '&') xml.append("&amp;");
        else if (c == '<') xml.append("&lt;");
        else if (c == '>') xml.append("&gt;");
        else if (c == '"') xml.append("&quot;");
        else if (c == '\n') xml.append("&#10;");
        else if (c < 0x20 && c != '\t') continue;
        else xml.append(c);
      }
    }
    xml.append('"');
  }

  private static void flag(StringBuilder xml, String name, boolean value) {
    xml.append(' ').append(name).append("=\"").append(value).append('"');
  }

  // The default display's size as input sees it, turned with the screen.
  private static void display(JSONObject answer) throws Exception {
    Class<?> global = Class.forName("android.hardware.display.DisplayManagerGlobal");
    Object manager = global.getDeclaredMethod("getInstance").invoke(null);
    Object info = global.getDeclaredMethod("getDisplayInfo", int.class).invoke(manager, 0);
    if (info == null) throw new IllegalStateException("The display is not available.");
    Class<?> type = info.getClass();
    answer.put("width", type.getField("logicalWidth").getInt(info));
    answer.put("height", type.getField("logicalHeight").getInt(info));
    answer.put("rotation", type.getField("rotation").getInt(info));
    answer.put("density", type.getField("logicalDensityDpi").getInt(info));
  }

  // The screen as JPEG, scale screen pixels to one picture pixel.
  private void shot(double scale, int quality, JSONObject answer) throws Exception {
    Bitmap screen = automation().takeScreenshot();
    if (screen == null) throw new IllegalStateException("The screen could not be captured.");
    if (screen.getConfig() == Bitmap.Config.HARDWARE) {
      Bitmap copy = screen.copy(Bitmap.Config.ARGB_8888, false);
      screen.recycle();
      screen = copy;
    }
    double per = scale > 0 ? scale : 1;
    int width = Math.max(1, (int) Math.round(screen.getWidth() / per));
    int height = Math.max(1, (int) Math.round(screen.getHeight() / per));
    Bitmap scaled = width != screen.getWidth() || height != screen.getHeight() ? Bitmap.createScaledBitmap(screen, width, height, true) : screen;
    ByteArrayOutputStream jpeg = new ByteArrayOutputStream(256 * 1024);
    scaled.compress(Bitmap.CompressFormat.JPEG, Math.max(1, Math.min(100, quality)), jpeg);
    answer.put("jpeg", Base64.encodeToString(jpeg.toByteArray(), Base64.NO_WRAP));
    answer.put("width", scaled.getWidth()).put("height", scaled.getHeight());
    answer.put("screenWidth", screen.getWidth()).put("screenHeight", screen.getHeight());
    if (scaled != screen) scaled.recycle();
    screen.recycle();
  }
}
