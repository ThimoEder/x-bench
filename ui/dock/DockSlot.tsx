import { useDesk } from "../deskContext.ts";
import { remotePage } from "../launchToken.ts";
import type { Layout } from "../useLayout.ts";
import type { PageSnapshot } from "../useSnapshot.ts";
import type { ShownSession } from "./deskView.ts";
import { Dock, DockLoading } from "./Dock.tsx";
import { DOCK_LIMIT, reachDim } from "./dockReach.ts";
import { PaneBoundary } from "./PaneBoundary.tsx";
import type { useDock } from "./useDock.ts";

export interface DockSlotProps {
  session: ShownSession;
  open: boolean;
  layout: Layout;
  dock: ReturnType<typeof useDock>;
  snapshot: PageSnapshot;
  phone: boolean;
  railHost: HTMLElement | null;
}

export function DockSlot({ session, open, layout, dock, snapshot, phone, railHost }: DockSlotProps) {
  const { call } = useDesk();
  const remote = remotePage();
  const { reaching, dockShown, workspaceWidth, dockLimit, dockMax, dockSlotWidth, setDockWidth, setDockOpen, dragging, beginResize, onSeparatorKey, terminalPlace } = layout;
  return (
    <>
      {open && reaching ? (
        <button
          type="button"
          className="reach-veil"
          aria-label="Bring the chat back"
          style={{ "--reach-dim": reachDim(dockShown, workspaceWidth, dockLimit) }}
          onClick={() => setDockWidth(DOCK_LIMIT)}
        />
      ) : null}
      <div
        className={["splitter", dragging === "dock" ? "is-dragging" : "", open ? "" : "is-closed"].filter(Boolean).join(" ")}
        inert={open ? undefined : true}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize review"
        aria-valuemin={320}
        aria-valuemax={Math.round(dockMax)}
        aria-valuenow={Math.round(dockShown)}
        tabIndex={0}
        style={open && reaching ? { transform: `translateX(${dockSlotWidth - dockShown}px)` } : undefined}
        onPointerDown={(event) => beginResize(event, "dock")}
        onKeyDown={(event) => onSeparatorKey("dock", event)}
        onDoubleClick={() => setDockWidth(440)}
      />
      <div
        className={open && reaching ? "dock-slot open reaching" : open ? "dock-slot open" : "dock-slot"}
        style={{ width: open ? dockSlotWidth : 0, "--dock-inner": `${dockShown}px` }}
        inert={open ? undefined : true}
      >
        <PaneBoundary resetKey={session.id} label="The review">
          {session.loading ? (
            <DockLoading
              key={session.id}
              sessionId={session.id}
              open={open}
              railHost={phone ? null : railHost}
              onOpen={() => setDockOpen(true)}
              onClose={() => setDockOpen(false)}
              browser={!remote && Boolean(snapshot.browser)}
              terminalInDock={!remote && terminalPlace === "dock"}
              running={Boolean(snapshot.terminals[session.id]?.some((item) => item.running))}
            />
          ) : (
            <Dock
              session={session}
              call={call}
              open={open}
              railHost={phone ? null : railHost}
              onOpen={() => setDockOpen(true)}
              reviewNonce={dock.reviewNonce}
              openedFile={dock.openedFile}
              browser={remote ? null : snapshot.browser}
              shells={snapshot.terminals[session.id]}
              terminalNonce={dock.terminalNonce}
              terminalInDock={!remote && terminalPlace === "dock"}
              onMoveTerminal={() => dock.moveTerminal(session.id, "bottom")}
              onTabs={dock.setDockTabs}
              deviceFocus={snapshot.deviceFocus}
              agent={snapshot.providers.find((provider) => provider.id === session.provider)?.label}
              onClose={() => setDockOpen(false)}
              phone={phone}
            />
          )}
        </PaneBoundary>
      </div>
    </>
  );
}
