// Draws a Syphon server's frames (Unity's Game view through KlakSyphon) in a CAMetalLayer over the app window.
// Each frame is one GPU draw from the server's IOSurface into the layer's drawable, on Syphon's queue, with no
// JavaScript per frame. The view passes every mouse event through to the page beneath it.

#import <Cocoa/Cocoa.h>
#import <Metal/Metal.h>
#import <QuartzCore/QuartzCore.h>
#import "SyphonMetalClient.h"
#import "SyphonServerDirectory.h"
#import "flip.h"
#include <node_api.h>
#include <atomic>
#include <string>

@interface XBUnityView : NSView
@end

@implementation XBUnityView
- (BOOL)isFlipped {
  return YES;
}
- (NSView *)hitTest:(NSPoint)point {
  return nil;
}
@end

static id<MTLDevice> device;
static id<MTLCommandQueue> queue;
static id<MTLRenderPipelineState> pipeline;
static CAMetalLayer *layer;
static XBUnityView *view;
static SyphonMetalClient *client;
static NSString *clientName;
static std::atomic<uint64_t> frames{0};
// Frames are only drawn while the view shows, so a hidden tab costs no GPU work.
static std::atomic<bool> shown{false};
static std::atomic<uint32_t> frameWidth{0};
static std::atomic<uint32_t> frameHeight{0};

static napi_value undefinedValue(napi_env env) {
  napi_value value;
  napi_get_undefined(env, &value);
  return value;
}

static napi_value boolValue(napi_env env, bool flag) {
  napi_value value;
  napi_get_boolean(env, flag, &value);
  return value;
}

static NSString *stringArg(napi_env env, napi_value value) {
  size_t length = 0;
  napi_get_value_string_utf8(env, value, nullptr, 0, &length);
  std::string text(length, '\0');
  napi_get_value_string_utf8(env, value, text.data(), length + 1, &length);
  return [NSString stringWithUTF8String:text.c_str()];
}

static void drawFrame(SyphonMetalClient *source) {
  if (!shown) return;
  id<MTLTexture> texture = [source newFrameImage];
  if (!texture || !layer) return;
  CGSize size = CGSizeMake(texture.width, texture.height);
  if (!CGSizeEqualToSize(layer.drawableSize, size)) layer.drawableSize = size;
  id<CAMetalDrawable> drawable = [layer nextDrawable];
  if (!drawable) return;
  id<MTLCommandBuffer> buffer = [queue commandBuffer];
  encodeFlip(buffer, pipeline, texture, drawable.texture);
  [buffer presentDrawable:drawable];
  [buffer commit];
  frameWidth = (uint32_t)texture.width;
  frameHeight = (uint32_t)texture.height;
  frames++;
}

// attach(handle: Buffer) puts the view over the window whose content NSView the handle points to.
static napi_value Attach(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  void *data = nullptr;
  size_t length = 0;
  napi_get_buffer_info(env, argv[0], &data, &length);
  if (length < sizeof(void *)) return boolValue(env, false);
  NSView *content = (__bridge NSView *)(*(void **)data);
  if (!device) {
    device = MTLCreateSystemDefaultDevice();
    queue = [device newCommandQueue];
    pipeline = makeFlipPipeline(device, MTLPixelFormatBGRA8Unorm);
  }
  if (!view) {
    layer = [CAMetalLayer layer];
    layer.device = device;
    layer.pixelFormat = MTLPixelFormatBGRA8Unorm;
    layer.framebufferOnly = NO;
    layer.contentsGravity = kCAGravityResizeAspect;
    layer.backgroundColor = CGColorGetConstantColor(kCGColorBlack);
    layer.opaque = YES;
    view = [[XBUnityView alloc] initWithFrame:NSZeroRect];
    view.layer = layer;
    view.wantsLayer = YES;
  }
  shown = false;
  view.hidden = YES;
  [view removeFromSuperview];
  [content addSubview:view positioned:NSWindowAbove relativeTo:nil];
  return boolValue(env, true);
}

// setBounds(x, y, width, height) in the window's content coordinates from its top left, or setBounds() to hide.
static napi_value SetBounds(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (!view) return undefinedValue(env);
  if (argc < 4) {
    shown = false;
    view.hidden = YES;
    return undefinedValue(env);
  }
  double box[4];
  for (int i = 0; i < 4; i++) napi_get_value_double(env, argv[i], &box[i]);
  NSView *content = view.superview;
  if (content.subviews.lastObject != view) {
    [view removeFromSuperview];
    [content addSubview:view positioned:NSWindowAbove relativeTo:nil];
  }
  double y = content.isFlipped ? box[1] : content.bounds.size.height - box[1] - box[3];
  [CATransaction begin];
  [CATransaction setDisableActions:YES];
  view.frame = NSMakeRect(box[0], y, box[2], box[3]);
  layer.contentsScale = content.window.backingScaleFactor ?: 2;
  view.hidden = NO;
  [CATransaction commit];
  shown = true;
  return undefinedValue(env);
}

// connect(name) starts drawing the named Syphon server, and answers whether it is connected.
static napi_value Connect(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  NSString *name = stringArg(env, argv[0]);
  if (client && client.isValid && [clientName isEqualToString:name]) return boolValue(env, true);
  [client stop];
  client = nil;
  if (!device) return boolValue(env, false);
  for (NSDictionary *server in [SyphonServerDirectory sharedDirectory].servers) {
    if (![server[SyphonServerDescriptionNameKey] isEqualToString:name]) continue;
    client = [[SyphonMetalClient alloc] initWithServerDescription:server
                                                           device:device
                                                          options:nil
                                                  newFrameHandler:^(SyphonMetalClient *source) {
                                                    drawFrame(source);
                                                  }];
    clientName = name;
    return boolValue(env, client.isValid);
  }
  return boolValue(env, false);
}

static napi_value Disconnect(napi_env env, napi_callback_info info) {
  [client stop];
  client = nil;
  return undefinedValue(env);
}

static void setNumber(napi_env env, napi_value object, const char *key, double number) {
  napi_value value;
  napi_create_double(env, number, &value);
  napi_set_named_property(env, object, key, value);
}

static napi_value Stats(napi_env env, napi_callback_info info) {
  napi_value object;
  napi_create_object(env, &object);
  setNumber(env, object, "frames", (double)frames.load());
  setNumber(env, object, "width", frameWidth.load());
  setNumber(env, object, "height", frameHeight.load());
  napi_set_named_property(env, object, "connected", boolValue(env, client && client.isValid));
  return object;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor methods[] = {
      {"attach", nullptr, Attach, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"setBounds", nullptr, SetBounds, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"connect", nullptr, Connect, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"disconnect", nullptr, Disconnect, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"stats", nullptr, Stats, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
