cask "pandoras-gate" do
  version "0.0.0"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"

  url "https://github.com/tdarwin/pandoras_gate/releases/download/v#{version}/Pandoras-Gate-#{version}-arm64.dmg"
  name "Pandora's Gate"
  desc "Novel-writing studio with local and remote AI assistance"
  homepage "https://github.com/tdarwin/pandoras_gate"

  depends_on arch: :arm64
  depends_on macos: ">= :ventura"

  app "Pandora's Gate.app"

  zap trash: [
    "~/Library/Application Support/pandoras-gate",
    "~/Library/Preferences/com.davintaddeo.pandorasgate.plist",
    "~/Library/Saved Application State/com.davintaddeo.pandorasgate.savedState",
  ]
end
