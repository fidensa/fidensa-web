import "server-only";

export interface DataProviderBoundary {
  readonly kind: "data";
  healthCheck(): Promise<"available" | "unavailable">;
}

export interface MessageProviderBoundary {
  readonly kind: "message";
  healthCheck(): Promise<"available" | "unavailable">;
}

export function providerAdaptersUnavailable(): never {
  throw new Error(
    "Provider adapters are unavailable until their separately approved implementation task.",
  );
}
