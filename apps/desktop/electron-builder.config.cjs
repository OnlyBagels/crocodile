// One-click installers for everyone: no admin rights, no configuration.
// Code signing is used when the release workflow provides it: a Developer ID
// certificate for macOS (CSC_LINK etc.), Azure Artifact Signing for Windows
// (AZURE_SIGN_*). Otherwise macOS builds are ad-hoc signed so they run on
// Apple Silicon, and Windows builds are unsigned (see docs/DISTRIBUTION.md).
const signed = !!process.env.CSC_LINK;

/** Azure Artifact Signing for Windows; the login comes from AZURE_TENANT_ID etc. */
function azureSigning() {
  const env = process.env;
  if (!env.AZURE_SIGN_ENDPOINT) return undefined;
  const options = {
    endpoint: env.AZURE_SIGN_ENDPOINT,
    codeSigningAccountName: env.AZURE_SIGN_ACCOUNT,
    certificateProfileName: env.AZURE_SIGN_PROFILE,
    // Exactly the certificate's subject name: the updater checks new
    // versions are signed by it.
    publisherName: env.AZURE_SIGN_PUBLISHER,
  };
  const missing = Object.entries(options).filter(([, v]) => !v);
  if (missing.length)
    throw new Error(
      `Windows signing is half set up; missing ${missing.map(([k]) => k).join(', ')}`,
    );
  return options;
}
const azureSignOptions = azureSigning();

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'chat.crocodile.app',
  productName: 'Crocodile',
  executableName: 'crocodile',
  copyright: 'Copyright © Crocodile contributors',
  directories: { output: 'release', buildResources: 'build' },
  files: ['dist/**', 'package.json'],
  // Native push-to-talk hook must live outside the asar.
  asarUnpack: ['dist/native/**'],
  extraResources: [{ from: 'resources', to: '.' }],
  asar: true,
  // Everything else is bundled by esbuild/Vite; no node_modules ship.
  npmRebuild: false,
  nodeGypRebuild: false,
  protocols: [{ name: 'Crocodile invite', schemes: ['croc'] }],
  // Upload into the release for the tag (created by the workflow as a draft,
  // or published by hand in the GitHub UI).
  publish: {
    provider: 'github',
    owner: 'pwalda',
    repo: 'crocodile',
    releaseType: 'release',
    // Release tags are beta-v1.2.3 during the beta (set by the release workflow).
    tagNamePrefix: process.env.CROC_TAG_PREFIX || 'v',
  },
  // Predictable names for scripts/install.sh and install.ps1.
  artifactName: 'Crocodile-${version}-${os}-${arch}.${ext}',
  // Lets the app know whether macOS auto-update can work (needs Developer ID).
  extraMetadata: { crocSigned: signed },

  mac: {
    category: 'public.app-category.social-networking',
    target: [
      { target: 'dmg', arch: ['universal'] },
      { target: 'zip', arch: ['universal'] },
    ],
    // "-" = ad-hoc signature: required for Apple Silicon to launch the app at all.
    identity: signed ? undefined : '-',
    hardenedRuntime: signed,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    // Push-to-talk binaries are per-arch files already; don't try to lipo them.
    x64ArchFiles: 'Contents/Resources/app.asar.unpacked/dist/native/**',
    notarize: signed && !!process.env.APPLE_ID,
    extendInfo: {
      NSMicrophoneUsageDescription: 'Crocodile uses your microphone for voice chat.',
      NSCameraUsageDescription: 'Crocodile uses your camera for video calls.',
    },
  },
  dmg: { title: 'Install Crocodile' },

  win: {
    target: [{ target: 'nsis', arch: ['x64', 'arm64'] }],
    ...(azureSignOptions ? { azureSignOptions } : {}),
  },
  nsis: {
    // Per-user install, no UAC prompt, launches when done.
    oneClick: true,
    perMachine: false,
    createDesktopShortcut: 'always',
    createStartMenuShortcut: true,
    runAfterFinish: true,
    deleteAppDataOnUninstall: false,
  },

  linux: {
    syncDesktopName: true,
    category: 'Network;Chat;InstantMessaging',
    synopsis: 'Peer-to-peer, end-to-end encrypted voice, video and text chat',
    target: [
      { target: 'AppImage', arch: ['x64', 'arm64'] },
      { target: 'deb', arch: ['x64', 'arm64'] },
      { target: 'rpm', arch: ['x64'] },
      { target: 'tar.gz', arch: ['x64', 'arm64'] },
    ],
    maintainer: 'Crocodile contributors <contact@crocodilechat.com>',
    mimeTypes: ['x-scheme-handler/croc'],
    desktop: { entry: { StartupWMClass: 'Crocodile' } },
  },
};
