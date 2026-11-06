// xbench-sim: drives one booted iOS simulator for the X Bench host through Meta's FBSimulatorControl.
// It streams the framebuffer as H.264, sends touches, buttons and keys straight to the simulator's HID
// channel, and reads the frontmost app's accessibility tree.
//
// Usage: xbench-sim --udid <UDID>
// stdin: one JSON request per line, {"id": 1, "op": "tap", ...}.
// stdout: frames of 1 byte kind, 4 bytes big-endian length, payload. Kind 0 is a JSON reply
// ({"id", "ok", "result" | "error"}) or event ({"event"}); kind 1 is one H.264 access unit in Annex B.
// stderr: log lines.

import CoreGraphics
import FBControlCore
import FBSimulatorControl
import Foundation

final class Output: @unchecked Sendable {
  private let lock = NSLock()
  private let handle = FileHandle.standardOutput

  func send(kind: UInt8, _ payload: Data) {
    var header = Data([kind])
    var length = UInt32(payload.count).bigEndian
    header.append(Data(bytes: &length, count: 4))
    lock.lock()
    defer { lock.unlock() }
    handle.write(header + payload)
  }

  func json(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
    send(kind: 0, data)
  }
}

let output = Output()

func log(_ message: String) {
  FileHandle.standardError.write(Data("xbench-sim: \(message)\n".utf8))
}

struct HelperError: Error, CustomStringConvertible {
  let description: String
  init(_ description: String) { self.description = description }
}

final class FrameConsumer: NSObject, FBDataConsumer {
  func consumeData(_ data: Data) {
    output.send(kind: 1, data)
  }

  func consumeEndOfFile() {}
}

final class NoReporter: NSObject, FBEventReporter {
  var metadata: [String: String] = [:]
  func report(_ subject: FBEventReporterSubject) {}
  func addMetadata(_ metadata: [String: String]) {}
}

@MainActor
final class Helper {
  let udid: String
  let logger: FBControlCoreLogger
  var simulator: FBSimulator!
  var hid: FBSimulatorHID?
  var stream: FBVideoStream?
  var consumer: FrameConsumer?

  init(udid: String) {
    self.udid = udid
    logger = FBControlCoreLoggerFactory.systemLoggerWriting(toStderr: true, withDebugLogging: false)
  }

  func setUp() async throws {
    FBControlCoreGlobalConfiguration.defaultLogger = logger
    try FBSimulatorControlFrameworkLoader.essentialFrameworks.loadPrivateFrameworks(logger)
    try FBSimulatorControlFrameworkLoader.xcodeFrameworks.loadPrivateFrameworks(logger)
    let configuration = FBSimulatorControlConfiguration(deviceSetPath: nil, logger: logger, reporter: NoReporter())
    let control = try FBSimulatorControl.withConfiguration(configuration)
    guard let found = control.set.allSimulators.first(where: { $0.udid == udid }) else {
      throw HelperError("No simulator has the UDID \(udid).")
    }
    guard found.state == .booted else {
      throw HelperError("\(found.name) is not booted.")
    }
    simulator = found
  }

  func connectedHID() async throws -> FBSimulatorHID {
    if let hid { return hid }
    let connected = try await simulator.connectToHID()
    hid = connected
    return connected
  }

  func send(_ event: FBSimulatorHIDEvent) async throws {
    try await connectedHID().send(event: event, logger: logger)
  }

  func handle(_ request: [String: Any]) async throws -> Any {
    let op = request["op"] as? String ?? ""
    switch op {
    case "stream":
      try await startStream(request)
      return info()
    case "stop-stream":
      try await stopStream()
      return [:] as [String: Any]
    case "touch":
      try await send(.touch(direction: direction(request), x: number(request, "x"), y: number(request, "y")))
      return [:] as [String: Any]
    case "touch2":
      try await send(.twoFingerTouch(direction: direction(request), finger1: point(request, "x1", "y1"), finger2: point(request, "x2", "y2")))
      return [:] as [String: Any]
    case "tap":
      let x = try number(request, "x")
      let y = try number(request, "y")
      let hold = max(0.05, (request["hold"] as? Double) ?? 0.05)
      try await send(.composite([.touch(direction: .down, x: x, y: y), .delay(hold), .touch(direction: .up, x: x, y: y)]))
      return [:] as [String: Any]
    case "path":
      try await send(pathEvent(request))
      return [:] as [String: Any]
    case "button":
      let button = try buttonOf(request["name"] as? String ?? "")
      let hold = max(0.05, (request["hold"] as? Double) ?? 0.1)
      try await send(.composite([.button(direction: .down, button: button), .delay(hold), .button(direction: .up, button: button)]))
      return [:] as [String: Any]
    case "key":
      guard let code = request["code"] as? Int, code > 0 else { throw HelperError("Give a HID key code.") }
      if request["phase"] != nil {
        try await send(.keyboard(direction: direction(request), keyCode: UInt32(code)))
        return [:] as [String: Any]
      }
      let hold = max(0.02, (request["hold"] as? Double) ?? 0.02)
      try await send(.composite([.keyboard(direction: .down, keyCode: UInt32(code)), .delay(hold), .keyboard(direction: .up, keyCode: UInt32(code))]))
      return [:] as [String: Any]
    case "type":
      try await send(.composite(try typingEvents(request["text"] as? String ?? "")))
      return [:] as [String: Any]
    case "shake":
      try await send(.shake)
      return [:] as [String: Any]
    // iOS hides its on-screen keyboard while a hardware keyboard is connected; keys still type either way.
    case "hardware-keyboard":
      try simulator.device.setHardwareKeyboardEnabled((request["enabled"] as? Bool) ?? true, keyboardType: try keyboardType())
      return [:] as [String: Any]
    case "describe":
      return try await describe()
    default:
      throw HelperError("Unknown op \(op).")
    }
  }

  func info() -> [String: Any] {
    let screen = simulator.screenInfo
    let scale = Double(screen?.scale ?? 0)
    let widthPixels = Double(screen?.widthPixels ?? 0)
    let heightPixels = Double(screen?.heightPixels ?? 0)
    return [
      "widthPixels": widthPixels,
      "heightPixels": heightPixels,
      "width": scale > 0 ? widthPixels / scale : 0,
      "height": scale > 0 ? heightPixels / scale : 0,
    ]
  }

  func startStream(_ request: [String: Any]) async throws {
    if stream != nil { try await stopStream() }
    let fps = (request["fps"] as? Int) ?? 60
    let scale = (request["scale"] as? Double) ?? 1
    let bitrate = (request["bitrate"] as? Int) ?? 6_000_000
    let configuration = FBVideoStreamConfiguration(
      format: .compressedVideo(withCodec: .h264, transport: .annexB),
      framesPerSecond: NSNumber(value: fps),
      rateControl: .bitrate(NSNumber(value: bitrate)),
      scaleFactor: NSNumber(value: scale),
      keyFrameRate: NSNumber(value: 2.0)
    )
    let created = try await simulator.createStream(configuration: configuration)
    let sink = FrameConsumer()
    try await created.startStreamingAsync(sink)
    stream = created
    consumer = sink
  }

  func stopStream() async throws {
    guard let current = stream else { return }
    stream = nil
    consumer = nil
    try await current.stopStreamingAsync()
  }

  // One finger, or two when points2 is given, down at the first point, through the rest, and up at the last.
  func pathEvent(_ request: [String: Any]) throws -> FBSimulatorHIDEvent {
    let first = try samples(request["points"])
    let second = request["points2"] == nil ? nil : try samples(request["points2"])
    guard first.count >= 2 else { throw HelperError("A path needs at least two points.") }
    if let second, second.count != first.count { throw HelperError("Both fingers need the same number of points.") }
    var events: [FBSimulatorHIDEvent] = []
    for (index, sample) in first.enumerated() {
      if index > 0, sample.dt > 0 { events.append(.delay(sample.dt)) }
      let phase: FBSimulatorHIDDirection = index == first.count - 1 ? .up : .down
      if let second {
        events.append(.twoFingerTouch(direction: phase, finger1: sample.point, finger2: second[index].point))
      } else {
        events.append(.touch(direction: phase, x: sample.point.x, y: sample.point.y))
      }
    }
    return .composite(events)
  }

  func describe() async throws -> Any {
    var latest: Any = []
    for attempt in 0..<5 {
      let element = try await simulator.accessibilityElementForFrontmostApplication()
      defer { element.close() }
      let response = try element.serialize(with: FBAccessibilityRequestOptions(nestedFormat: true, keys: Helper.treeKeys))
      latest = response.elements
      if let roots = latest as? [[String: Any]], roots.contains(where: { ($0["children"] as? [Any])?.isEmpty == false }) {
        return latest
      }
      if attempt < 4 { try await Task.sleep(for: .milliseconds(50 << attempt)) }
    }
    return latest
  }

  static let treeKeys: Set<FBAXKeys> = [.label, .frame, .value, .uniqueID, .type, .title, .frameDict, .enabled, .role]
}

struct Sample {
  let point: CGPoint
  let dt: TimeInterval
}

func samples(_ value: Any?) throws -> [Sample] {
  guard let items = value as? [[String: Any]] else { throw HelperError("Give points as a list of {x, y, dt}.") }
  return try items.map { item in
    guard let x = item["x"] as? Double, let y = item["y"] as? Double else { throw HelperError("Each point needs x and y.") }
    return Sample(point: CGPoint(x: x, y: y), dt: max(0, ((item["dt"] as? Double) ?? 0) / 1000))
  }
}

func number(_ request: [String: Any], _ key: String) throws -> Double {
  guard let value = request[key] as? Double, value.isFinite else { throw HelperError("Give \(key).") }
  return value
}

func point(_ request: [String: Any], _ x: String, _ y: String) throws -> CGPoint {
  CGPoint(x: try number(request, x), y: try number(request, y))
}

func direction(_ request: [String: Any]) -> FBSimulatorHIDDirection {
  (request["phase"] as? String) == "up" ? .up : .down
}

func buttonOf(_ name: String) throws -> FBSimulatorHIDButton {
  switch name {
  case "home": return .homeButton
  case "lock": return .lock
  case "side": return .sideButton
  case "siri": return .siri
  default: throw HelperError("Unknown button \(name).")
  }
}

func keyboardType() throws -> UInt8 {
  guard let kit = Bundle(identifier: "com.apple.SimulatorKit")?.dlopenExecutablePath() else { throw HelperError("SimulatorKit is not loaded.") }
  typealias KeyboardTypeFn = @convention(c) () -> UInt8
  return unsafeBitCast(FBGetSymbolFromHandle(kit, "IndigoHIDGetKeyboardType"), to: KeyboardTypeFn.self)()
}

// HID usage codes of a US keyboard, and whether shift is held.
func keyOf(_ character: Character) -> (code: UInt32, shift: Bool)? {
  let plain: [Character: UInt32] = [
    "\n": 40, "\t": 43, " ": 44, "-": 45, "=": 46, "[": 47, "]": 48, "\\": 49, ";": 51, "'": 52, "`": 53, ",": 54, ".": 55, "/": 56,
  ]
  let shifted: [Character: UInt32] = [
    "!": 30, "@": 31, "#": 32, "$": 33, "%": 34, "^": 35, "&": 36, "*": 37, "(": 38, ")": 39,
    "_": 45, "+": 46, "{": 47, "}": 48, "|": 49, ":": 51, "\"": 52, "~": 53, "<": 54, ">": 55, "?": 56,
  ]
  if let code = plain[character] { return (code, false) }
  if let code = shifted[character] { return (code, true) }
  guard let ascii = character.asciiValue else { return nil }
  switch ascii {
  case 97...122: return (UInt32(ascii - 97 + 4), false)
  case 65...90: return (UInt32(ascii - 65 + 4), true)
  case 49...57: return (UInt32(ascii - 49 + 30), false)
  case 48: return (39, false)
  default: return nil
  }
}

func typingEvents(_ text: String) throws -> [FBSimulatorHIDEvent] {
  var events: [FBSimulatorHIDEvent] = []
  for character in text {
    guard let key = keyOf(character) else {
      throw HelperError("The simulator's keyboard cannot type \"\(character)\". Type plain ASCII characters.")
    }
    if key.shift { events.append(.keyboard(direction: .down, keyCode: 225)) }
    events.append(.keyboard(direction: .down, keyCode: key.code))
    events.append(.keyboard(direction: .up, keyCode: key.code))
    if key.shift { events.append(.keyboard(direction: .up, keyCode: 225)) }
  }
  return events
}

func plain(_ value: Any) -> Any {
  if let list = value as? [Any] { return list.map(plain) }
  if let dictionary = value as? [String: Any] {
    var copy: [String: Any] = [:]
    for (key, item) in dictionary { copy[key] = plain(item) }
    return copy
  }
  if let number = value as? NSNumber { return number }
  if let string = value as? String { return string }
  if value is NSNull { return NSNull() }
  return "\(value)"
}

@main
struct Main {
  static func main() async {
    let arguments = CommandLine.arguments
    guard let index = arguments.firstIndex(of: "--udid"), index + 1 < arguments.count else {
      log("usage: xbench-sim --udid <UDID>")
      exit(64)
    }
    signal(SIGPIPE, SIG_IGN)
    let helper = await Helper(udid: arguments[index + 1])
    do {
      try await helper.setUp()
    } catch {
      output.json(["event": "failed", "error": "\(error)"])
      exit(1)
    }
    output.json(["event": "ready", "info": await helper.info()])

    // A helper serves one boot of its simulator. Once that ends it leaves, and the host starts a new one.
    let simulator = await helper.simulator!
    Task.detached {
      while true {
        try? await Task.sleep(for: .seconds(2))
        if simulator.state != .booted {
          output.json(["event": "gone"])
          exit(0)
        }
      }
    }

    // Requests run one after another, so touches keep their order.
    let lines = AsyncStream<String> { continuation in
      Thread.detachNewThread {
        while let line = readLine(strippingNewline: true) {
          continuation.yield(line)
        }
        continuation.finish()
      }
    }
    for await line in lines {
      guard let data = line.data(using: .utf8),
            let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
      let id = request["id"] ?? NSNull()
      do {
        let result = try await helper.handle(request)
        output.json(["id": id, "ok": true, "result": plain(result)])
      } catch {
        output.json(["id": id, "ok": false, "error": "\(error)"])
      }
    }
    try? await helper.stopStream()
    exit(0)
  }
}
