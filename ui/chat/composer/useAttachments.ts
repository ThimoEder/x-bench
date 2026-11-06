import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { attachmentFromPath, attachmentRecord, mergeAttachments, withoutAttachment } from "./attachments.ts";
import type { Attachment } from "./attachments.ts";

export interface AttachmentsOptions {
  session: { id: string };
  filesRef: RefObject<Attachment[]>;
  replaceAttachments: (next: Attachment[]) => void;
}

// Files added by picker, paste or drop. A file removed while others are still being read
// stays out when that read finishes.
export function useAttachments({ session, filesRef, replaceAttachments }: AttachmentsOptions) {
  const [attachError, setAttachError] = useState("");
  const dropEpoch = useRef(0);
  const blocked = useRef<{ key: string; epoch: number }[]>([]);

  useEffect(() => {
    setAttachError("");
  }, [session.id]);

  async function takeFiles(list: File[]) {
    const started = dropEpoch.current;
    const incoming: Attachment[] = [];
    let error = "";
    for (const file of list) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const result = attachmentRecord({
          name: file.name,
          mimeType: file.type,
          bytes,
          id: crypto.randomUUID(),
        });
        if (!result.attachment) {
          error = result.error;
          continue;
        }
        if (result.attachment.kind === "image") result.attachment.preview = await thumbnail(result.attachment.previewUrl);
        incoming.push(result.attachment);
      } catch {
        error = `Couldn't read ${file.name || "that file"}.`;
      }
    }
    const blockedKeys = new Set(blocked.current.filter((entry) => entry.epoch > started).map((entry) => entry.key));
    const fresh = incoming.filter((item) => !item.data || !blockedKeys.has(item.data));
    const merged = mergeAttachments(filesRef.current, fresh);
    replaceAttachments(merged.attachments);
    setAttachError(merged.error || error);
  }

  function addPaths(paths: string[]) {
    const incoming = paths.map((filePath) => attachmentFromPath({ filePath, id: crypto.randomUUID() }));
    const merged = mergeAttachments(filesRef.current, incoming);
    replaceAttachments(merged.attachments);
    setAttachError(merged.error);
  }

  function removeAttachment(id: string) {
    dropEpoch.current += 1;
    const file = filesRef.current.find((item) => item.id === id);
    if (file?.data) blocked.current.push({ key: file.data, epoch: dropEpoch.current });
    if (file?.path) blocked.current.push({ key: `path:${file.path}`, epoch: dropEpoch.current });
    replaceAttachments(withoutAttachment(filesRef.current, id));
    setAttachError("");
  }

  return { attachError, setAttachError, takeFiles, addPaths, removeAttachment };
}

function thumbnail(src: string) {
  return new Promise<string>((resolve) => {
    const image = new Image();
    image.onload = () => {
      const width = image.naturalWidth || image.width;
      const height = image.naturalHeight || image.height;
      const max = 320;
      const scale = Math.min(1, max / Math.max(width, height, 1));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext("2d");
      if (!context) {
        resolve("");
        return;
      }
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    image.onerror = () => resolve("");
    image.src = src;
  });
}
