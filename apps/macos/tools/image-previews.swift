// A batch of local JPEGs on stdin. Return oriented, sRGB RGBA previews in input order.
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let paths = try JSONDecoder().decode([String].self, from: FileHandle.standardInput.readDataToEndOfFile())
let space = CGColorSpace(name: CGColorSpace.sRGB)!
let options = [
    kCGImageSourceThumbnailMaxPixelSize: 32,
    kCGImageSourceCreateThumbnailFromImageAlways: true,
    kCGImageSourceCreateThumbnailWithTransform: true,
] as CFDictionary

func preview(_ path: String) -> Data? {
    guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          CGImageSourceGetType(source) as String? == UTType.jpeg.identifier,
          let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
          let width = props[kCGImagePropertyPixelWidth] as? UInt32,
          let height = props[kCGImagePropertyPixelHeight] as? UInt32,
          let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options),
          image.width > 0, image.width <= 32, image.height > 0, image.height <= 32,
          let context = CGContext(data: nil, width: image.width, height: image.height,
                                  bitsPerComponent: 8, bytesPerRow: image.width * 4, space: space,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
          let pixels = context.data else { return nil }
    context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
    let turned = (props[kCGImagePropertyOrientation] as? Int ?? 1) >= 5
    let header = [turned ? height : width, turned ? width : height, UInt32(image.width), UInt32(image.height)]
    var data = header.map { $0.littleEndian }.withUnsafeBytes { Data($0) }
    data.append(pixels.assumingMemoryBound(to: UInt8.self), count: image.width * image.height * 4)
    return data
}

let count = paths.count
let output = UnsafeMutablePointer<Data?>.allocate(capacity: count)
output.initialize(repeating: nil, count: count)
DispatchQueue.concurrentPerform(iterations: count) { i in
    output[i] = autoreleasepool { preview(paths[i]) }
}
var batch = Data()
for i in 0..<count {
    if let record = output[i] { batch.append(record) }
    else { batch.append(Data(repeating: 0, count: 16)) }
}
output.deinitialize(count: count)
output.deallocate()
FileHandle.standardOutput.write(batch)
