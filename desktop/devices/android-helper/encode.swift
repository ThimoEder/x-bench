// xbench-encode: turns raw screen frames into H.264 on the Mac's hardware encoder, for the Android emulator's
// live view. The emulator hands X Bench uncompressed frames, and this keeps them at full size and rate.
//
// Usage: xbench-encode [--bitrate <bits per second>]
// stdin: frames of 1 byte flags (bit 0 asks for a key frame), 4 bytes big-endian width, 4 bytes height, then
// width × height × 3 bytes of RGB888.
// stdout: frames of 1 byte kind, 4 bytes big-endian length, payload, as xbench-sim writes them. Kind 1 is one
// H.264 access unit in Annex B, with the parameter sets before each key frame.
// stderr: log lines.

import Accelerate
import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox

let startCode: [UInt8] = [0, 0, 0, 1]
let stdout = FileHandle.standardOutput
let writeLock = NSLock()

func log(_ message: String) {
  FileHandle.standardError.write(Data("xbench-encode: \(message)\n".utf8))
}

func send(_ payload: Data) {
  var header = Data([1])
  var length = UInt32(payload.count).bigEndian
  header.append(Data(bytes: &length, count: 4))
  writeLock.lock()
  defer { writeLock.unlock() }
  stdout.write(header + payload)
}

func readExactly(_ count: Int, into buffer: UnsafeMutableRawPointer) -> Bool {
  var done = 0
  while done < count {
    let got = read(0, buffer + done, count - done)
    if got <= 0 { return false }
    done += got
  }
  return true
}

// One encoded frame: its NAL units from the sample buffer, in Annex B, with SPS and PPS before a key frame.
func annexB(_ sample: CMSampleBuffer) -> Data? {
  guard let block = CMSampleBufferGetDataBuffer(sample) else { return nil }
  let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[CFString: Any]]
  let key = !((attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool) ?? false)
  var out = Data()
  if key, let format = CMSampleBufferGetFormatDescription(sample) {
    var count = 0
    CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: 0, parameterSetPointerOut: nil, parameterSetSizeOut: nil, parameterSetCountOut: &count, nalUnitHeaderLengthOut: nil)
    for index in 0..<count {
      var pointer: UnsafePointer<UInt8>?
      var size = 0
      if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: index, parameterSetPointerOut: &pointer, parameterSetSizeOut: &size, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil) == noErr, let pointer {
        out.append(contentsOf: startCode)
        out.append(pointer, count: size)
      }
    }
  }
  // Copied out, since the block buffer need not be one contiguous piece of memory.
  let total = CMBlockBufferGetDataLength(block)
  var bytes = [UInt8](repeating: 0, count: total)
  guard CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: total, destination: &bytes) == noErr else { return nil }
  var at = 0
  while at + 4 <= total {
    let size = Int(bytes[at]) << 24 | Int(bytes[at + 1]) << 16 | Int(bytes[at + 2]) << 8 | Int(bytes[at + 3])
    at += 4
    if size <= 0 || at + size > total { break }
    out.append(contentsOf: startCode)
    out.append(contentsOf: bytes[at..<(at + size)])
    at += size
  }
  return out
}

final class Encoder {
  let width: Int
  let height: Int
  let bitrate: Int
  var session: VTCompressionSession?
  var pool: CVPixelBufferPool?
  var argb: [UInt8]

  init(width: Int, height: Int, bitrate: Int) throws {
    self.width = width
    self.height = height
    self.bitrate = bitrate
    argb = [UInt8](repeating: 0, count: width * height * 4)
    let spec: [CFString: Any] = [kVTVideoEncoderSpecification_EnableLowLatencyRateControl: true]
    let attributes: [CFString: Any] = [
      kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA,
      kCVPixelBufferWidthKey: width,
      kCVPixelBufferHeightKey: height,
      kCVPixelBufferIOSurfacePropertiesKey: [:] as [CFString: Any],
    ]
    var made: VTCompressionSession?
    let status = VTCompressionSessionCreate(allocator: nil, width: Int32(width), height: Int32(height), codecType: kCMVideoCodecType_H264, encoderSpecification: spec as CFDictionary, imageBufferAttributes: attributes as CFDictionary, compressedDataAllocator: nil, outputCallback: nil, refcon: nil, compressionSessionOut: &made)
    guard status == noErr, let made else { throw NSError(domain: "xbench-encode", code: Int(status), userInfo: [NSLocalizedDescriptionKey: "The H.264 encoder could not start (\(status))."]) }
    VTSessionSetProperty(made, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
    VTSessionSetProperty(made, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
    VTSessionSetProperty(made, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_High_AutoLevel)
    VTSessionSetProperty(made, key: kVTCompressionPropertyKey_AverageBitRate, value: bitrate as CFNumber)
    VTSessionSetProperty(made, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: 60 as CFNumber)
    VTSessionSetProperty(made, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: 600 as CFNumber)
    VTSessionSetProperty(made, key: kVTCompressionPropertyKey_MaxFrameDelayCount, value: 0 as CFNumber)
    VTCompressionSessionPrepareToEncodeFrames(made)
    session = made
    pool = VTCompressionSessionGetPixelBufferPool(made)
  }

  func encode(rgb: UnsafeMutableRawPointer, key: Bool) {
    guard let session, let pool else { return }
    var buffer: CVPixelBuffer?
    guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer) == kCVReturnSuccess, let buffer else { return }
    CVPixelBufferLockBaseAddress(buffer, [])
    var source = vImage_Buffer(data: rgb, height: vImagePixelCount(height), width: vImagePixelCount(width), rowBytes: width * 3)
    argb.withUnsafeMutableBytes { scratch in
      var middle = vImage_Buffer(data: scratch.baseAddress, height: vImagePixelCount(height), width: vImagePixelCount(width), rowBytes: width * 4)
      var target = vImage_Buffer(data: CVPixelBufferGetBaseAddress(buffer), height: vImagePixelCount(height), width: vImagePixelCount(width), rowBytes: CVPixelBufferGetBytesPerRow(buffer))
      vImageConvert_RGB888toARGB8888(&source, nil, 255, &middle, false, vImage_Flags(kvImageNoFlags))
      let order: [UInt8] = [3, 2, 1, 0]
      vImagePermuteChannels_ARGB8888(&middle, &target, order, vImage_Flags(kvImageNoFlags))
    }
    CVPixelBufferUnlockBaseAddress(buffer, [])
    let time = CMTime(value: CMTimeValue(DispatchTime.now().uptimeNanoseconds / 1000), timescale: 1_000_000)
    let properties: [CFString: Any] = key ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] : [:]
    VTCompressionSessionEncodeFrame(session, imageBuffer: buffer, presentationTimeStamp: time, duration: .invalid, frameProperties: properties as CFDictionary, infoFlagsOut: nil) { status, _, sample in
      guard status == noErr, let sample, let data = annexB(sample) else { return }
      send(data)
    }
  }

  func finish() {
    guard let session else { return }
    VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
    VTCompressionSessionInvalidate(session)
    self.session = nil
  }
}

var bitrate = 16_000_000
let args = CommandLine.arguments
if let at = args.firstIndex(of: "--bitrate"), at + 1 < args.count, let value = Int(args[at + 1]) { bitrate = value }

var encoder: Encoder?
var header = [UInt8](repeating: 0, count: 9)
var frame = [UInt8]()
while header.withUnsafeMutableBytes({ readExactly(9, into: $0.baseAddress!) }) {
  let flags = header[0]
  let width = Int(UInt32(header[1]) << 24 | UInt32(header[2]) << 16 | UInt32(header[3]) << 8 | UInt32(header[4]))
  let height = Int(UInt32(header[5]) << 24 | UInt32(header[6]) << 16 | UInt32(header[7]) << 8 | UInt32(header[8]))
  guard width > 0, height > 0, width <= 8192, height <= 8192 else {
    log("frame size \(width)x\(height) is out of range")
    exit(1)
  }
  let size = width * height * 3
  if frame.count != size { frame = [UInt8](repeating: 0, count: size) }
  guard frame.withUnsafeMutableBytes({ readExactly(size, into: $0.baseAddress!) }) else { break }
  var key = flags & 1 == 1
  if encoder == nil || encoder?.width != width || encoder?.height != height {
    encoder?.finish()
    do {
      encoder = try Encoder(width: width, height: height, bitrate: bitrate)
    } catch {
      log(error.localizedDescription)
      exit(1)
    }
    key = true
  }
  frame.withUnsafeMutableBytes { encoder?.encode(rgb: $0.baseAddress!, key: key) }
}
encoder?.finish()
