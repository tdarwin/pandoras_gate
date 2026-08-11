cask "pandoras-box" do
  version "0.0.0"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"

  url "https://github.com/tdarwin/pandoras_box/releases/download/v#{version}/Pandoras-Box-#{version}-arm64.dmg"
  name "Pandora's Box"
  desc "Novel-writing studio with local and remote AI assistance"
  homepage "https://github.com/tdarwin/pandoras_box"

  depends_on arch: :arm64
  depends_on macos: ">= :ventura"

  app "Pandora's Box.app"

  zap trash: [
    "~/Library/Application Support/pandoras-box",
    "~/Library/Preferences/com.davintaddeo.pandorasbox.plist",
    "~/Library/Saved Application State/com.davintaddeo.pandorasbox.savedState",
  ]
end
