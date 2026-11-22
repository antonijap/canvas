// Generate phone-sized JPEGs with a header, rows, and a different pattern on every screen.
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let count = Int(CommandLine.arguments[2])!
let width = 1170, height = 2532
let space = CGColorSpace(name: CGColorSpace.sRGB)!
DispatchQueue.concurrentPerform(iterations: min(8, count)) { worker in
    var pixels = [UInt32](repeating: 0, count: width * height)
    for y in 0..<height {
        let row = y % 188
        for x in 0..<width {
            let inside = x > 56 && x < width - 56
            let card = inside && y > 400 && row < 152
            let line = card && x > 260 && x < 950 && (row / 12 == 4 || row / 12 == 7)
            let noise = ((x &* 73856093) ^ (y &* 19349663)) & 31
            let shade = UInt32(line ? 140 : card ? 185 : 130) + UInt32(noise)
            pixels[y * width + x] = 0xff000000 | (shade << 16) | (shade << 8) | shade
        }
    }
    for index in stride(from: worker, to: count, by: min(8, count)) {
        autoreleasepool {
            pixels.withUnsafeMutableBytes { bytes in
                let surface = CGContext(data: bytes.baseAddress, width: width, height: height,
                                        bitsPerComponent: 8, bytesPerRow: width * 4, space: space,
                                        bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)!
                surface.setFillColor(red: Double(index % 223) / 222, green: Double((index / 223 * 13) % 43) / 42,
                                     blue: Double((index * 31) % 127) / 126, alpha: 1)
                surface.fill(CGRect(x: 0, y: height - 348, width: width, height: 348))
                let file = directory.appendingPathComponent("screen-\(index).jpg")
                let output = CGImageDestinationCreateWithURL(file as CFURL, UTType.jpeg.identifier as CFString, 1, nil)!
                CGImageDestinationAddImage(output, surface.makeImage()!, [kCGImageDestinationLossyCompressionQuality: 0.43] as CFDictionary)
                precondition(CGImageDestinationFinalize(output))
            }
        }
    }
}
