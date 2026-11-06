import assert from "node:assert/strict";
import test from "node:test";
import { findElement, parseDescribeUi, parseUiautomator, writeTree } from "./screenTree.ts";

// describe-ui output: the app, a field, a button with its label inside, an unnamed image, and a keyboard key
// below the 874 point screen.
const IOS = [
  {
    type: "Application",
    role: "AXApplication",
    AXLabel: "Sample",
    AXFrame: "{{0, 0}, {402, 874}}",
    frame: { x: 0, y: 0, width: 402, height: 874 },
    enabled: true,
    children: [
      { type: "TextField", AXUniqueId: "nameField", AXValue: "Your name", frame: { x: 32, y: 223, width: 338, height: 22 }, enabled: true, children: [] },
      {
        type: "Button",
        AXLabel: "Continue",
        AXUniqueId: "continueButton",
        AXFrame: "{{16, 295}, {370, 52}}",
        enabled: false,
        children: [{ type: "Image", frame: { x: 20, y: 300, width: 10, height: 10 }, children: [] }],
      },
      { type: "Button", AXLabel: "q", frame: { x: 4, y: 959, width: 36, height: 54 }, children: [] },
      { type: "Group", children: [{ type: "StaticText", AXLabel: "Hello", frame: { x: 10, y: 400, width: 50, height: 20 }, children: [] }] },
    ],
  },
];

test("an iOS screen reads as lines with refs at the centers of on-screen elements", () => {
  const { lines, refs } = writeTree(parseDescribeUi(IOS));
  assert.deepEqual(lines, [
    '- Application "Sample" (0,0 402×874) [e1]',
    '  - TextField id=nameField value="Your name" (32,223 338×22) [e2]',
    '  - Button "Continue" id=continueButton disabled (16,295 370×52) [e3]',
    '  - StaticText "Hello" (10,400 50×20) [e4]',
  ]);
  assert.deepEqual(refs.get("e3"), { point: { x: 201, y: 321 }, label: 'Button "Continue"' });
});

test("the interactive filter keeps only the controls", () => {
  const { lines } = writeTree(parseDescribeUi(IOS), true);
  assert.deepEqual(lines, ['- TextField id=nameField value="Your name" (32,223 338×22) [e1]', '- Button "Continue" id=continueButton disabled (16,295 370×52) [e2]']);
});


const XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
<node index="0" text="" resource-id="" class="android.widget.FrameLayout" clickable="false" enabled="true" bounds="[0,0][1080,2400]">
<node index="0" text="" resource-id="com.android.settings:id/row" class="android.widget.LinearLayout" clickable="true" enabled="true" bounds="[0,315][1080,507]">
<node index="0" text="Network &amp; internet" resource-id="android:id/title" class="android.widget.TextView" clickable="false" enabled="true" bounds="[221,350][566,407]" />
<node index="1" text="Mobile, Wi‑Fi" resource-id="android:id/summary" class="android.widget.TextView" clickable="false" enabled="true" bounds="[221,407][572,458]" />
</node>
<node index="1" text="" resource-id="" class="android.widget.ImageView" clickable="false" enabled="true" bounds="[0,0][10,10]" />
<node index="2" text="wifi" resource-id="com.android.settings:id/search" class="android.widget.EditText" clickable="true" focused="true" enabled="true" bounds="[126,63][1080,252]" />
</node>
</hierarchy>`;

test("an Android dump reads in dp, and a clickable row takes its texts as its label", () => {
  const { lines, refs } = writeTree(parseUiautomator(XML, 2.625), true);
  assert.deepEqual(lines, ['- LinearLayout "Network & internet · Mobile, Wi‑Fi" id=row (0,120 411.4×73.1) [e1]', '- EditText "wifi" id=search focused (48,24 363.4×72) [e2]']);
  assert.deepEqual(refs.get("e1")?.point, { x: 205.7, y: 156.6 });
});

test("an element partly off the screen gets its ref in the part that shows", () => {
  const tree = [{ type: "Application", frame: { x: 0, y: 0, width: 402, height: 874 }, children: [{ type: "Button", AXLabel: "Partly visible", frame: { x: 10, y: -100, width: 100, height: 120 } }] }];
  assert.deepEqual(writeTree(parseDescribeUi(tree)).refs.get("e1")?.point, { x: 60, y: 10 });
});

test("an element is found by its label, id or value, an exact match and a control first, and only on the screen", () => {
  const nodes = parseDescribeUi(IOS);
  assert.deepEqual(findElement(nodes, "continue"), { point: { x: 201, y: 321 }, label: 'Button "Continue"' });
  assert.deepEqual(findElement(nodes, "nameField"), { point: { x: 201, y: 234 }, label: "TextField nameField" });
  assert.equal(findElement(nodes, "Your name")?.label, "TextField nameField");
  assert.equal(findElement(nodes, "hell")?.label, 'StaticText "Hello"');
  assert.equal(findElement(nodes, "Sample")?.label, 'Application "Sample"');
  assert.equal(findElement(nodes, "q"), null);
  assert.equal(findElement(nodes, " "), null);
});
