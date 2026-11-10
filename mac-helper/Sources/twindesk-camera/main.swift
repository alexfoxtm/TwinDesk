// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The virtual camera's Camera Extension (macOS 12.3+, a system extension in
// TwinDesk.app/Contents/Library/SystemExtensions, installed by twindesk-vcam activate): one device,
// "TwinDesk Camera", with two streams. Apps read the source stream; TwinDesk writes its frames
// into the sink stream (twindesk-vcam feed). The source sends the newest frame 30 times a second,
// or black while none has come for a while. NV12 1280×720, BT.601 (shared/vcam-feed.js).
import CoreMediaIO
import CoreMedia
import CoreVideo
import Foundation
import IOKit.audio

let width: Int32 = 1280
let height: Int32 = 720
let fps: Int32 = 30
let cameraName = "TwinDesk Camera"
let staleNanos: UInt64 = 1_500_000_000

func nanos() -> UInt64 { clock_gettime_nsec_np(CLOCK_UPTIME_RAW) }

class StreamSource: NSObject, CMIOExtensionStreamSource {
  private(set) var stream: CMIOExtensionStream!
  let format: CMIOExtensionStreamFormat
  let sink: Bool
  weak var owner: DeviceSource?

  init(name: String, id: UUID, format: CMIOExtensionStreamFormat, sink: Bool, owner: DeviceSource) {
    self.format = format
    self.sink = sink
    self.owner = owner
    super.init()
    stream = CMIOExtensionStream(localizedName: name, streamID: id, direction: sink ? .sink : .source, clockType: .hostTime, source: self)
  }

  var formats: [CMIOExtensionStreamFormat] { [format] }

  var availableProperties: Set<CMIOExtensionProperty> {
    var p: Set<CMIOExtensionProperty> = [.streamActiveFormatIndex, .streamFrameDuration]
    if sink { p.formUnion([.streamSinkBufferQueueSize, .streamSinkBuffersRequiredForStartup, .streamSinkBufferUnderrunCount, .streamSinkEndOfData]) }
    return p
  }

  func streamProperties(forProperties properties: Set<CMIOExtensionProperty>) throws -> CMIOExtensionStreamProperties {
    let p = CMIOExtensionStreamProperties(dictionary: [:])
    if properties.contains(.streamActiveFormatIndex) { p.activeFormatIndex = 0 }
    if properties.contains(.streamFrameDuration) { p.frameDuration = CMTime(value: 1, timescale: fps) }
    if sink {
      if properties.contains(.streamSinkBufferQueueSize) { p.sinkBufferQueueSize = 1 }
      if properties.contains(.streamSinkBuffersRequiredForStartup) { p.sinkBuffersRequiredForStartup = 1 }
    }
    return p
  }

  func setStreamProperties(_ streamProperties: CMIOExtensionStreamProperties) throws {}

  func authorizedToStartStream(for client: CMIOExtensionClient) -> Bool {
    if sink { owner?.sinkClient = client }
    return true
  }

  func startStream() throws {
    if sink { owner?.startSink() } else { owner?.startSource() }
  }

  func stopStream() throws {
    if sink { owner?.stopSink() } else { owner?.stopSource() }
  }
}

class DeviceSource: NSObject, CMIOExtensionDeviceSource {
  private(set) var device: CMIOExtensionDevice!
  private var source: StreamSource!
  private var sink: StreamSource!
  private var formatDescription: CMFormatDescription!
  private var pool: CVPixelBufferPool!
  private var blackFrame: CVPixelBuffer?
  private let queue = DispatchQueue(label: "io.github.alexfoxtm.twindesk.camera", qos: .userInteractive)
  private var timer: DispatchSourceTimer?
  private var readers = 0
  private var sinking = false
  var sinkClient: CMIOExtensionClient?
  private var latest: CVPixelBuffer?
  private var latestAt: UInt64 = 0

  init(name: String) {
    super.init()
    device = CMIOExtensionDevice(localizedName: name, deviceID: UUID(uuidString: "36D4122A-6D38-4C6A-B622-E9DD756F6C5D")!, legacyDeviceID: nil, source: self)
    let ext: [String: Any] = [
      kCVImageBufferYCbCrMatrixKey as String: kCVImageBufferYCbCrMatrix_ITU_R_601_4,
      kCVImageBufferColorPrimariesKey as String: kCVImageBufferColorPrimaries_SMPTE_C,
      kCVImageBufferTransferFunctionKey as String: kCVImageBufferTransferFunction_ITU_R_709_2,
    ]
    CMVideoFormatDescriptionCreate(allocator: kCFAllocatorDefault, codecType: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, width: width, height: height, extensions: ext as CFDictionary, formatDescriptionOut: &formatDescription)
    let attrs: [String: Any] = [
      kCVPixelBufferWidthKey as String: width,
      kCVPixelBufferHeightKey as String: height,
      kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
      kCVPixelBufferIOSurfacePropertiesKey as String: [:],
    ]
    CVPixelBufferPoolCreate(kCFAllocatorDefault, nil, attrs as CFDictionary, &pool)
    let duration = CMTime(value: 1, timescale: fps)
    let format = CMIOExtensionStreamFormat(formatDescription: formatDescription, maxFrameDuration: duration, minFrameDuration: duration, validFrameDurations: nil)
    source = StreamSource(name: name, id: UUID(uuidString: "FCEBBA03-9D13-4C13-9940-CC84FCD132D1")!, format: format, sink: false, owner: self)
    sink = StreamSource(name: name + " (from TwinDesk)", id: UUID(uuidString: "2B6C4D5E-7F80-4A91-B2C3-D4E5F6071829")!, format: format, sink: true, owner: self)
    try? device.addStream(source.stream)
    try? device.addStream(sink.stream)
  }

  var availableProperties: Set<CMIOExtensionProperty> { [.deviceTransportType, .deviceModel] }

  func deviceProperties(forProperties properties: Set<CMIOExtensionProperty>) throws -> CMIOExtensionDeviceProperties {
    let p = CMIOExtensionDeviceProperties(dictionary: [:])
    if properties.contains(.deviceTransportType) { p.transportType = kIOAudioDeviceTransportTypeVirtual }
    if properties.contains(.deviceModel) { p.model = cameraName }
    return p
  }

  func setDeviceProperties(_ deviceProperties: CMIOExtensionDeviceProperties) throws {}

  private func black() -> CVPixelBuffer? {
    if let b = blackFrame { return b }
    var b: CVPixelBuffer?
    CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &b)
    guard let buf = b else { return nil }
    CVPixelBufferLockBaseAddress(buf, [])
    for (plane, value) in [(0, UInt8(16)), (1, UInt8(128))] {
      if let base = CVPixelBufferGetBaseAddressOfPlane(buf, plane) {
        memset(base, Int32(value), CVPixelBufferGetBytesPerRowOfPlane(buf, plane) * CVPixelBufferGetHeightOfPlane(buf, plane))
      }
    }
    CVPixelBufferUnlockBaseAddress(buf, [])
    blackFrame = buf
    return buf
  }

  // ---- apps reading ----

  func startSource() {
    queue.async {
      self.readers += 1
      guard self.timer == nil else { return }
      let t = DispatchSource.makeTimerSource(flags: .strict, queue: self.queue)
      t.schedule(deadline: .now(), repeating: 1.0 / Double(fps), leeway: .milliseconds(2))
      t.setEventHandler { [weak self] in self?.tick() }
      self.timer = t
      t.resume()
    }
  }

  func stopSource() {
    queue.async {
      self.readers = max(0, self.readers - 1)
      if self.readers == 0 {
        self.timer?.cancel()
        self.timer = nil
      }
    }
  }

  private func tick() {
    let now = nanos()
    let frame = (latest != nil && now - latestAt < staleNanos) ? latest : black()
    guard let buf = frame else { return }
    var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: fps), presentationTimeStamp: CMClockGetTime(CMClockGetHostTimeClock()), decodeTimeStamp: .invalid)
    var sample: CMSampleBuffer?
    guard CMSampleBufferCreateForImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: buf, dataReady: true, makeDataReadyCallback: nil, refcon: nil, formatDescription: formatDescription, sampleTiming: &timing, sampleBufferOut: &sample) == noErr, let s = sample else { return }
    source.stream.send(s, discontinuity: [], hostTimeInNanoseconds: now)
  }

  // ---- TwinDesk writing ----

  func startSink() {
    queue.async {
      self.sinking = true
      self.consume()
    }
  }

  func stopSink() {
    queue.async {
      self.sinking = false
      self.sinkClient = nil
    }
  }

  private func consume() {
    guard sinking, let client = sinkClient else { return }
    sink.stream.consumeSampleBuffer(from: client) { [weak self] sample, seq, _, _, _ in
      guard let self = self else { return }
      self.queue.async {
        if let s = sample, let buf = CMSampleBufferGetImageBuffer(s) {
          self.latest = buf
          self.latestAt = nanos()
          self.sink.stream.notifyScheduledOutputChanged(CMIOExtensionScheduledOutput(sequenceNumber: seq, hostTimeInNanoseconds: self.latestAt))
          self.consume()
        } else {
          // Nothing waiting: look again in a moment.
          self.queue.asyncAfter(deadline: .now() + .milliseconds(10)) { self.consume() }
        }
      }
    }
  }
}

class ProviderSource: NSObject, CMIOExtensionProviderSource {
  private(set) var provider: CMIOExtensionProvider!
  private var deviceSource: DeviceSource!

  init(clientQueue: DispatchQueue?) {
    super.init()
    provider = CMIOExtensionProvider(source: self, clientQueue: clientQueue)
    deviceSource = DeviceSource(name: cameraName)
    try? provider.addDevice(deviceSource.device)
  }

  func connect(to client: CMIOExtensionClient) throws {}
  func disconnect(from client: CMIOExtensionClient) {}

  var availableProperties: Set<CMIOExtensionProperty> { [.providerManufacturer] }

  func providerProperties(forProperties properties: Set<CMIOExtensionProperty>) throws -> CMIOExtensionProviderProperties {
    let p = CMIOExtensionProviderProperties(dictionary: [:])
    if properties.contains(.providerManufacturer) { p.manufacturer = "TwinDesk" }
    return p
  }

  func setProviderProperties(_ providerProperties: CMIOExtensionProviderProperties) throws {}
}

let providerSource = ProviderSource(clientQueue: nil)
CMIOExtensionProvider.startService(provider: providerSource.provider)
CFRunLoopRun()
