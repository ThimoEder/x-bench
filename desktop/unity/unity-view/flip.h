// Syphon frames have their origin at the bottom left, so the view draws them upside down into its target
// with one full-screen triangle. The shader compiles at runtime, which needs no Metal toolchain at build time.

#import <Metal/Metal.h>

static NSString *const flipShader = @"#include <metal_stdlib>\n"
                                     "using namespace metal;\n"
                                     "struct Out { float4 position [[position]]; float2 uv; };\n"
                                     "vertex Out flipVertex(uint id [[vertex_id]]) {\n"
                                     "  float2 p = float2((id << 1) & 2, id & 2);\n"
                                     "  Out out; out.position = float4(p * 2 - 1, 0, 1); out.uv = p; return out;\n"
                                     "}\n"
                                     "fragment float4 flipFragment(Out in [[stage_in]], texture2d<float> source [[texture(0)]]) {\n"
                                     "  constexpr sampler s(filter::nearest);\n"
                                     "  return source.sample(s, in.uv);\n"
                                     "}\n";

static id<MTLRenderPipelineState> makeFlipPipeline(id<MTLDevice> device, MTLPixelFormat format) {
  NSError *error = nil;
  id<MTLLibrary> library = [device newLibraryWithSource:flipShader options:nil error:&error];
  if (!library) {
    NSLog(@"Unity view shader: %@", error);
    return nil;
  }
  MTLRenderPipelineDescriptor *descriptor = [MTLRenderPipelineDescriptor new];
  descriptor.vertexFunction = [library newFunctionWithName:@"flipVertex"];
  descriptor.fragmentFunction = [library newFunctionWithName:@"flipFragment"];
  descriptor.colorAttachments[0].pixelFormat = format;
  return [device newRenderPipelineStateWithDescriptor:descriptor error:&error];
}

static void encodeFlip(id<MTLCommandBuffer> buffer, id<MTLRenderPipelineState> pipeline, id<MTLTexture> source, id<MTLTexture> target) {
  MTLRenderPassDescriptor *pass = [MTLRenderPassDescriptor renderPassDescriptor];
  pass.colorAttachments[0].texture = target;
  pass.colorAttachments[0].loadAction = MTLLoadActionDontCare;
  pass.colorAttachments[0].storeAction = MTLStoreActionStore;
  id<MTLRenderCommandEncoder> encoder = [buffer renderCommandEncoderWithDescriptor:pass];
  [encoder setRenderPipelineState:pipeline];
  [encoder setFragmentTexture:source atIndex:0];
  [encoder drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:3];
  [encoder endEncoding];
}
