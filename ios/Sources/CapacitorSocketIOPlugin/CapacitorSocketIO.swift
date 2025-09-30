import Foundation

@objc public class CapacitorSocketIO: NSObject {
    @objc public func echo(_ value: String) -> String {
        print(value)
        return value
    }
}
