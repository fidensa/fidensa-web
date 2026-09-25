import "server-only";

export class RequestBodyError extends Error {
  constructor(readonly reason: "content-type" | "size" | "json") {
    super("The request body is invalid.");
    this.name = "RequestBodyError";
  }
}

export async function readBoundedText(
  request: Request,
  maximumBytes: number,
): Promise<string> {
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > maximumBytes) {
    throw new RequestBodyError("size");
  }

  const reader = request.body?.getReader();
  if (!reader) throw new RequestBodyError("json");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel();
      throw new RequestBodyError("size");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new RequestBodyError("json");
  }
}

export async function readBoundedJson(
  request: Request,
  maximumBytes: number,
): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0];
  if (contentType !== "application/json")
    throw new RequestBodyError("content-type");
  try {
    return JSON.parse(await readBoundedText(request, maximumBytes));
  } catch (error) {
    if (error instanceof RequestBodyError) throw error;
    throw new RequestBodyError("json");
  }
}
