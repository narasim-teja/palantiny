// WebGL cannot read CSS variables, so the scene uses these sRGB equivalents of
// the OKLCH tokens in globals.css. Keep the two in step.
export const color = {
  surface: "#ffffff",
  ground: "#ebeef3",
  rule: "#dadee3",
  ruleStrong: "#b9bec6",
  sideLight: "#d5d9df",
  sideDark: "#c6cbd2",
  ink: "#101621",
  ink3: "#525864",
  you: "#0946a3",
  alert: "#c52012",
} as const;
