// electron-builder notarizes only the app, so this afterAllArtifactBuild hook sends the DMG with the same profile.
import { execFileSync } from "node:child_process";

export default function notarizeDmg({ artifactPaths }) {
  const profile = process.env.APPLE_KEYCHAIN_PROFILE;
  if (!profile) return [];
  for (const dmg of artifactPaths.filter((file) => file.endsWith(".dmg"))) {
    execFileSync("xcrun", ["notarytool", "submit", dmg, "--keychain-profile", profile, "--wait"], { stdio: "inherit" });
    execFileSync("xcrun", ["stapler", "staple", dmg], { stdio: "inherit" });
  }
  return [];
}
