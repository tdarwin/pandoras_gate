cask "pandoras-gate" do
  version "0.1.0"
  sha256 "bb89ed38d96e016fc4a0ba30d452d65fdff3c1a3a63bf4e64052339756cfe04b"

  url "https://github.com/tdarwin/pandoras_gate/releases/download/v#{version}/Pandoras-Gate-#{version}-arm64.dmg"
  name "Pandora's Gate"
  desc "Novel-writing studio with local and remote AI assistance"
  homepage "https://github.com/tdarwin/pandoras_gate"

  depends_on arch: :arm64
  depends_on macos: :ventura

  app "Pandora's Gate.app"

  # Releases are not yet signed with an Apple Developer ID; without this,
  # Gatekeeper reports the app as damaged. Remove once releases are notarized.
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
