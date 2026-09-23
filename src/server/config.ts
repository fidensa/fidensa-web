import "server-only";

import { validateRuntimeEnvironment } from "../config/environment";

export function getServerConfig() {
  return validateRuntimeEnvironment(process.env);
}
