cask "pandoras-gate" do
  version "0.2.0"
  sha256 "8e8fd28f9f7c959dd1cebbd13df8de25dc5bfcce256deaa7903b4c027e4f5f4d"

  url "https://github.com/tdarwin/pandoras_gate/releases/download/v#{version}/Pandoras-Gate-#{version}-arm64.dmg"
  name "Pandora's Gate"
  desc "Novel-writing studio with local and remote AI assistance"
  homepage "https://github.com/tdarwin/pandoras_gate"

  depends_on arch: :arm64
  depends_on macos: :ventura

  app "Pandora's Gate.app"

  # Releases are not yet signed with an Apple Developer ID; without
  # this, Gatekeeper reports the app as damaged. Remove once
  # releases are notarized.
  postflight do
    system_command "/usr/bin/xattr",
                   args: ["-cr", "#{appdir}/Pandora's Gate.app"],
                   sudo: false
  end

  zap trash: [
    "~/Library/Application Support/pandoras-gate",
    "~/Library/Preferences/com.davintaddeo.pandorasgate.plist",
    "~/Library/Saved Application State/com.davintaddeo.pandorasgate.savedState",
  ]
end
