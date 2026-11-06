import { useEffect, useState } from "react";
import type { PresentedAttachment, PresentedQueueEntry } from "../../server/present.ts";
import { fileBadge } from "./composer/attachments.ts";
import type { SessionCall } from "./Transcript.tsx";

export interface QueueProps {
  queue: PresentedQueueEntry[];
  act: SessionCall;
}

// Follow-ups queued behind the running turn. Each can be sent now, edited or deleted.
export function Queue({ queue, act }: QueueProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");

  useEffect(() => {
    if (editingId && !queue.some((entry) => entry.id === editingId)) setEditingId(null);
  }, [editingId, queue]);

  async function saveEdit(entry: PresentedQueueEntry) {
    const text = editingText.trim();
    if (!text) return;
    await act("/api/queue/edit", { id: entry.id, text, version: entry.version });
    setEditingId(null);
  }

  if (!queue.length) return null;
  return (
    <ul className="queue-list" data-testid="queue">
      {queue.map((entry) => (
        <li key={entry.id} className="queue-row" data-testid="queue-row">
          <div className="queue-main">
            <QueueFiles files={entry.attachments} />
            {editingId === entry.id ? (
              <textarea
                aria-label="Edit queued message"
                value={editingText}
                rows={2}
                onChange={(event) => setEditingText(event.target.value)}
              />
            ) : entry.text ? (
              <p className="queue-text">{entry.text}</p>
            ) : null}
          </div>
          {editingId === entry.id ? (
            <>
              <button type="button" onClick={() => saveEdit(entry)} disabled={!editingText.trim()}>
                Save
              </button>
              <button type="button" onClick={() => setEditingId(null)}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                aria-label="Send queued message now"
                onClick={() => act("/api/queue/send", { id: entry.id })}
              >
                Send now
              </button>
              <button
                type="button"
                aria-label="Edit queued message"
                onClick={() => {
                  setEditingId(entry.id);
                  setEditingText(entry.text);
                }}
              >
                Edit
              </button>
              <button
                type="button"
                aria-label="Delete queued message"
                onClick={() => act("/api/queue/remove", { id: entry.id, version: entry.version })}
              >
                Delete
              </button>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

function QueueFiles({ files }: { files: PresentedAttachment[] | undefined }) {
  if (!files?.length) return null;
  return (
    <ul className="queue-files">
      {files.map((file, index) => (
        <li key={`${file.name}-${index}`} className="queue-file" data-testid="queue-file">
          {file.preview ? <img src={file.preview} alt={file.name} /> : <span className="attach-kind">{fileBadge(file.name)}</span>}
          {file.preview ? null : <span className="attach-name">{file.name}</span>}
        </li>
      ))}
    </ul>
  );
}
