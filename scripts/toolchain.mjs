export function assertSupportedToolchain(nodeVersion, npmVersion) {
  if (nodeVersion !== "24.21.0") {
    throw new Error(
      `Unsupported Node.js version. Expected 24.21.0; received ${nodeVersion}.`,
    );
  }
  if (npmVersion !== "11.19.0") {
    throw new Error(
      `Unsupported npm version. Expected 11.19.0; received ${npmVersion}.`,
    );
  }
}
