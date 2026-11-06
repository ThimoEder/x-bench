import { useEffect, useRef, useState } from "react";
import type { MouseEvent, PointerEvent as ReactPointerEvent, RefObject } from "react";
import type { SidebarProject } from "../../server/snapshot.ts";
import type { ApiCall } from "../launchToken.ts";

interface DragOrigin {
  x: number;
  y: number;
  pointerId: number;
  cwd: string;
  name: string;
  boarded: boolean;
  left: number;
  width: number;
  offsetY: number;
  active: boolean;
  node: HTMLElement;
}

export interface ProjectDrag {
  cwd: string;
  name: string;
  boarded: boolean;
  left: number;
  width: number;
  offsetY: number;
  y: number;
  dropCwd: string | null;
}

function orderedProjects(projects: SidebarProject[], order: string[] | null) {
  if (!order) return projects;
  const byCwd = new Map(projects.map((project) => [project.cwd, project]));
  const next: SidebarProject[] = [];
  for (const cwd of order) {
    const project = byCwd.get(cwd);
    if (!project) continue;
    next.push(project);
    byCwd.delete(cwd);
  }
  for (const project of byCwd.values()) next.push(project);
  return next;
}

// Moving a project down lands after the row you drop on, because that row keeps its place until the source is removed.
function dropEdgeFor(projects: SidebarProject[], drag: ProjectDrag | null, cwd: string) {
  if (!drag || drag.dropCwd !== cwd) return "";
  const from = projects.findIndex((project) => project.cwd === drag.cwd);
  const to = projects.findIndex((project) => project.cwd === cwd);
  if (from < 0 || to < 0 || from === to) return "";
  return from < to ? "after" : "before";
}

// A new order shows at once and holds until the server's order matches it.
export function useProjectDrag(rootRef: RefObject<HTMLElement | null>, serverProjects: SidebarProject[], call: ApiCall | undefined, onStart: () => void) {
  const dragPoint = useRef<DragOrigin | null>(null);
  const projectDragRef = useRef<ProjectDrag | null>(null);
  const projectPointer = useRef<(() => void) | null>(null);
  const [drag, setDrag] = useState<ProjectDrag | null>(null);
  const [orderOverride, setOrderOverride] = useState<string[] | null>(null);
  const projects = orderedProjects(serverProjects, orderOverride);
  const projectsRef = useRef(projects);
  projectsRef.current = projects;

  useEffect(() => () => {
    projectPointer.current?.();
    document.body.classList.remove("is-project-drag");
  }, []);

  useEffect(() => {
    if (!orderOverride) return;
    const current = serverProjects.map((project) => project.cwd);
    if (current.length === orderOverride.length && current.every((cwd, index) => cwd === orderOverride[index])) {
      setOrderOverride(null);
    }
  }, [serverProjects, orderOverride]);

  function moveProject(source: string, targetCwd: string) {
    const order = projectsRef.current.map((project) => project.cwd);
    const from = order.indexOf(source);
    const to = order.indexOf(targetCwd);
    if (from < 0 || to < 0 || from === to) return;
    order.splice(from, 1);
    order.splice(to, 0, source);
    setOrderOverride(order);
    call?.("/api/projects/order", { cwd: order }).catch(() => setOrderOverride(null));
  }

  function projectUnder(y: number, sourceCwd: string) {
    const nodes = rootRef.current?.querySelectorAll<HTMLElement>(".project") ?? [];
    let best: HTMLElement | null = null;
    let bestDist = Infinity;
    for (const node of nodes) {
      const rect = node.getBoundingClientRect();
      const dist = y < rect.top ? rect.top - y : y >= rect.bottom ? y - rect.bottom : 0;
      if (dist < bestDist) {
        bestDist = dist;
        best = node;
      }
    }
    const cwd = best?.dataset.cwd || null;
    return cwd && cwd !== sourceCwd ? cwd : null;
  }

  function stopProjectPointer() {
    projectPointer.current?.();
    projectPointer.current = null;
  }

  function track(event: ReactPointerEvent<HTMLElement>, project: SidebarProject, boarded: boolean) {
    if (event.button !== 0) return;
    const head = event.currentTarget.closest(".project-head");
    const rect = (head || event.currentTarget).getBoundingClientRect();
    const origin: DragOrigin = {
      x: event.clientX,
      y: event.clientY,
      pointerId: event.pointerId,
      cwd: project.cwd,
      name: project.name,
      boarded,
      left: rect.left,
      width: rect.width,
      offsetY: event.clientY - rect.top,
      active: false,
      node: event.currentTarget,
    };
    dragPoint.current = origin;
    stopProjectPointer();

    function finish(ev: PointerEvent) {
      if (ev.pointerId !== origin.pointerId) return;
      stopProjectPointer();
      document.body.classList.remove("is-project-drag");
      const last = projectDragRef.current;
      projectDragRef.current = null;
      setDrag(null);
      if (origin.active && last?.dropCwd) moveProject(origin.cwd, last.dropCwd);
    }

    function move(ev: PointerEvent) {
      if (ev.pointerId !== origin.pointerId) return;
      if (!origin.active && Math.hypot(ev.clientX - origin.x, ev.clientY - origin.y) < 4) return;
      if (!origin.active) {
        origin.active = true;
        document.body.classList.add("is-project-drag");
        onStart();
        origin.node.setPointerCapture?.(ev.pointerId);
      }
      ev.preventDefault();
      const next: ProjectDrag = {
        cwd: origin.cwd,
        name: origin.name,
        boarded: origin.boarded,
        left: origin.left,
        width: origin.width,
        offsetY: origin.offsetY,
        y: ev.clientY,
        dropCwd: projectUnder(ev.clientY, origin.cwd),
      };
      projectDragRef.current = next;
      setDrag(next);
    }

    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    projectPointer.current = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
  }

  // True when the click ends a drag of the title, which then opens nothing.
  function endsDrag(event: MouseEvent) {
    const origin = dragPoint.current;
    dragPoint.current = null;
    if (origin?.active) return true;
    return Boolean(origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) >= 4);
  }

  return { projects, drag, track, endsDrag, dropEdge: (cwd: string) => dropEdgeFor(projects, drag, cwd) };
}

export type ProjectDragging = ReturnType<typeof useProjectDrag>;
