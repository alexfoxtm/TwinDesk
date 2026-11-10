// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// twindesk-vcam (TwinDesk.app/Contents/MacOS, beside the app: the system extension it installs
// must be in its main bundle): the virtual camera's side in TwinDesk (mac/vcam.js).
//   activate    installs the Camera Extension (io.github.alexfoxtm.twindesk.camera); the first time macOS asks
//               the person to allow it in System Settings: {"approval":true} is printed meanwhile,
//               and it waits (up to 5 minutes) for the answer
//   deactivate  removes it
//   status      {"camera":true|false}: is "TwinDesk Camera" among this Mac's cameras
//   feed        frames on stdin, each 1280×720 NV12 (shared/vcam-feed.js), into the camera's sink stream
// status and feed take --name <camera>: another camera with a sink stream, "OBS Virtual Camera"
// (OBS Studio's Camera Extension, written into the way OBS does), in the format its sink takes.
import CoreMediaIO
import CoreMedia
import CoreVideo
import Foundation
import SystemExtensions
import VideoToolbox

let extensionID = "io.github.alexfoxtm.twindesk.camera"
let args = Array(CommandLine.arguments.dropFirst())
let cameraName: String = {
  if let i = args.firstIndex(of: "--name"), i + 1 < args.count { return args[i + 1] }
  return "TwinDesk Camera"
}()
let width = 1280, height = 720
let frameBytes = width * height * 3 / 2

func say(_ obj: [String: Any]) {
  if let d = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: d, encoding: .utf8) {
    print(s)
    fflush(stdout)
  }
}

// ---- installing ----

class Request: NSObject, OSSystemExtensionRequestDelegate {
  func request(_ request: OSSystemExtensionRequest, actionForReplacingExtension existing: OSSystemExtensionProperties, withExtension ext: OSSystemExtensionProperties) -> OSSystemExtensionRequest.ReplacementAction {
    .replace
  }
  func requestNeedsUserApproval(_ request: OSSystemExtensionRequest) {
    say(["approval": true])
  }
  func request(_ request: OSSystemExtensionRequest, didFinishWithResult result: OSSystemExtensionRequest.Result) {
    say(["ok": true, "reboot": result == .willCompleteAfterReboot])
    exit(0)
  }
  func request(_ request: OSSystemExtensionRequest, didFailWithError error: Error) {
    say(["ok": false, "error": error.localizedDescription, "code": (error as NSError).code])
    exit(1)
  }
}

func install(_ activate: Bool) -> Never {
  let delegate = Request()
  let r = activate
    ? OSSystemExtensionRequest.activationRequest(forExtensionWithIdentifier: extensionID, queue: .main)
    : OSSystemExtensionRequest.deactivationRequest(forExtensionWithIdentifier: extensionID, queue: .main)
  r.delegate = delegate
  OSSystemExtensionManager.shared.submitRequest(r)
  DispatchQueue.main.asyncAfter(deadline: .now() + 300) {
    say(["ok": false, "error": "no answer from System Settings"])
    exit(1)
  }
  withExtendedLifetime(delegate) { dispatchMain() }
}

// ---- the camera, through CoreMediaIO ----

func property<T>(_ object: CMIOObjectID, _ selector: Int, scope: Int = kCMIOObjectPropertyScopeGlobal, _ empty: T) -> [T] {
  var addr = CMIOObjectPropertyAddress(mSelector: CMIOObjectPropertySelector(selector), mScope: CMIOObjectPropertyScope(scope), mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain))
  var size: UInt32 = 0
  guard CMIOObjectGetPropertyDataSize(object, &addr, 0, nil, &size) == noErr, size > 0 else { return [] }
  var items = [T](repeating: empty, count: Int(size) / MemoryLayout<T>.stride)
  var used: UInt32 = 0
  let status = items.withUnsafeMutableBytes { CMIOObjectGetPropertyData(object, &addr, 0, nil, size, &used, $0.baseAddress!) }
  return status == noErr ? items : []
}

func name(_ object: CMIOObjectID) -> String {
  var addr = CMIOObjectPropertyAddress(mSelector: CMIOObjectPropertySelector(kCMIOObjectPropertyName), mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal), mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain))
  var value: Unmanaged<CFString>?
  var used: UInt32 = 0
  guard CMIOObjectGetPropertyData(object, &addr, 0, nil, UInt32(MemoryLayout<Unmanaged<CFString>?>.size), &used, &value) == noErr, let v = value else { return "" }
  return v.takeRetainedValue() as String
}

func findCamera() -> CMIOObjectID? {
  property(CMIOObjectID(kCMIOObjectSystemObject), kCMIOHardwarePropertyDevices, CMIOObjectID(0)).first { name($0) == cameraName }
}

// The device's stream TwinDesk writes into: the one going into it (direction 0), else the last.
func sinkStream(_ device: CMIOObjectID) -> CMIOStreamID? {
  let streams = property(device, kCMIODevicePropertyStreams, CMIOStreamID(0))
  return streams.first { property($0, kCMIOStreamPropertyDirection, UInt32(1)).first == 0 } ?? streams.last
}

// The format the sink takes (OBS's: its own size and pixel format), if it says.
func sinkFormat(_ stream: CMIOStreamID) -> CMVideoFormatDescription? {
  var addr = CMIOObjectPropertyAddress(mSelector: CMIOObjectPropertySelector(kCMIOStreamPropertyFormatDescription), mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal), mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain))
  var value: Unmanaged<CMFormatDescription>?
  var used: UInt32 = 0
  guard CMIOObjectGetPropertyData(stream, &addr, 0, nil, UInt32(MemoryLayout<Unmanaged<CMFormatDescription>?>.size), &used, &value) == noErr, let v = value else { return nil }
  return v.takeRetainedValue()
}

func readAll(_ buf: UnsafeMutablePointer<UInt8>, _ count: Int) -> Bool {
  var got = 0
  while got < count {
    let n = read(0, buf + got, count - got)
    if n <= 0 { return false }
    got += n
  }
  return true
}

func feed() -> Never {
  // Wait for the camera (just installed: it shows up in a moment).
  var device: CMIOObjectID?
  for _ in 0..<50 {
    device = findCamera()
    if device != nil { break }
    usleep(100_000)
  }
  guard let dev = device, let stream = sinkStream(dev) else {
    FileHandle.standardError.write("no \(cameraName)\n".data(using: .utf8)!)
    exit(1)
  }
  var queue: Unmanaged<CMSimpleQueue>?
  let altered: CMIODeviceStreamQueueAlteredProc = { _, _, _ in }
  guard CMIOStreamCopyBufferQueue(stream, altered, nil, &queue) == noErr, let q = queue?.takeRetainedValue() else {
    FileHandle.standardError.write("no sink queue\n".data(using: .utf8)!)
    exit(1)
  }
  CMIODeviceStartStream(dev, stream)

  // NV12 at 1280×720 as it comes, or turned into the sink's own size and pixel format.
  let target = sinkFormat(stream)
  let dims = target.map { CMVideoFormatDescriptionGetDimensions($0) }
  let outW = dims.map { Int($0.width) } ?? width, outH = dims.map { Int($0.height) } ?? height
  let nv12 = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
  let outPixel = target.map { CMFormatDescriptionGetMediaSubType($0) } ?? nv12
  let convert = outW != width || outH != height || outPixel != nv12
  var transfer: VTPixelTransferSession?
  if convert {
    VTPixelTransferSessionCreate(allocator: kCFAllocatorDefault, pixelTransferSessionOut: &transfer)
    if let t = transfer { VTSessionSetProperty(t, key: kVTPixelTransferPropertyKey_ScalingMode, value: kVTScalingMode_Letterbox) }
    FileHandle.standardError.write("\(cameraName): \(outW)×\(outH) \(String(format: "%08x", outPixel))\n".data(using: .utf8)!)
  }
  func makePool(_ w: Int, _ h: Int, _ pixel: OSType) -> CVPixelBufferPool? {
    var pool: CVPixelBufferPool?
    let attrs: [String: Any] = [
      kCVPixelBufferWidthKey as String: w,
      kCVPixelBufferHeightKey as String: h,
      kCVPixelBufferPixelFormatTypeKey as String: pixel,
      kCVPixelBufferIOSurfacePropertiesKey as String: [:],
    ]
    CVPixelBufferPoolCreate(kCFAllocatorDefault, nil, attrs as CFDictionary, &pool)
    return pool
  }
  let pool = makePool(width, height, nv12)
  let outPool = convert ? makePool(outW, outH, outPixel) : nil
  var format: CMFormatDescription?
  let frame = UnsafeMutablePointer<UInt8>.allocate(capacity: frameBytes)
  while readAll(frame, frameBytes) {
    // The camera takes one at a time: a frame it hasn't taken yet is replaced by a newer one later.
    if CMSimpleQueueGetCount(q) >= CMSimpleQueueGetCapacity(q) { continue }
    var pb: CVPixelBuffer?
    guard let p = pool, CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, p, &pb) == kCVReturnSuccess, let buf = pb else { continue }
    CVPixelBufferLockBaseAddress(buf, [])
    for plane in 0..<2 {
      guard let base = CVPixelBufferGetBaseAddressOfPlane(buf, plane) else { continue }
      let stride = CVPixelBufferGetBytesPerRowOfPlane(buf, plane)
      let rows = plane == 0 ? height : height / 2
      let src = frame + (plane == 0 ? 0 : width * height)
      for r in 0..<rows { memcpy(base + r * stride, src + r * width, width) }
    }
    CVPixelBufferUnlockBaseAddress(buf, [])
    CVBufferSetAttachment(buf, kCVImageBufferYCbCrMatrixKey, kCVImageBufferYCbCrMatrix_ITU_R_601_4, .shouldPropagate)
    var image = buf
    if convert {
      var ob: CVPixelBuffer?
      guard let t = transfer, let op = outPool, CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, op, &ob) == kCVReturnSuccess, let o = ob,
            VTPixelTransferSessionTransferImage(t, from: buf, to: o) == noErr else { continue }
      image = o
    }
    if format == nil { CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: image, formatDescriptionOut: &format) }
    var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 30), presentationTimeStamp: CMClockGetTime(CMClockGetHostTimeClock()), decodeTimeStamp: .invalid)
    var sample: CMSampleBuffer?
    guard let f = format, CMSampleBufferCreateForImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: image, dataReady: true, makeDataReadyCallback: nil, refcon: nil, formatDescription: f, sampleTiming: &timing, sampleBufferOut: &sample) == noErr, let s = sample else { continue }
    let element = Unmanaged.passRetained(s)
    if CMSimpleQueueEnqueue(q, element: element.toOpaque()) != noErr { element.release() }
  }
  CMIODeviceStopStream(dev, stream)
  exit(0)
}

switch args.first ?? "" {
case "activate": install(true)
case "deactivate": install(false)
case "status": say(["ok": true, "camera": findCamera() != nil])
case "feed": feed()
default:
  FileHandle.standardError.write("usage: twindesk-vcam activate|deactivate|status|feed [--name <camera>]\n".data(using: .utf8)!)
  exit(2)
}
