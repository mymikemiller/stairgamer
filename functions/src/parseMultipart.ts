import Busboy from "busboy";
import type { InputImage } from "./image";

export interface ParsedUpload {
  image: InputImage | null;
  fields: Record<string, string>;
}

// Accepts multipart/form-data (the Android share target posts this) and also a
// raw image body, so a plain `fetch` with an image Blob works too.
export function parseMultipart(
  headers: Record<string, string | string[] | undefined>,
  body: Buffer,
): Promise<ParsedUpload> {
  const contentType = String(headers["content-type"] ?? "");

  if (!/multipart\/form-data/i.test(contentType)) {
    if (/^image\//i.test(contentType)) {
      return Promise.resolve({
        image: { mediaType: contentType.split(";")[0].trim(), base64: body.toString("base64") },
        fields: {},
      });
    }
    return Promise.resolve({ image: null, fields: {} });
  }

  return new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: headers as any, limits: { files: 1, fileSize: 25 * 1024 * 1024 } });
    const fields: Record<string, string> = {};
    let image: InputImage | null = null;

    busboy.on("field", (name, value) => { fields[name] = value; });

    busboy.on("file", (_name, stream, info) => {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => {
        if (!chunks.length) return;
        image = {
          // An Android share can mislabel HEIC as JPEG; normalizeImage checks
          // the magic bytes rather than trusting this.
          mediaType: info.mimeType || "image/jpeg",
          base64: Buffer.concat(chunks).toString("base64"),
        };
      });
    });

    busboy.on("finish", () => resolve({ image, fields }));
    busboy.on("error", reject);
    busboy.end(body);
  });
}
