// Diagram kinds beautiful-mermaid does not draw, told again as a flowchart it does: C4, mindmap, architecture,
// requirement and timeline diagrams are boxes and arrows at heart. The input is what Mermaid parsed (its
// diagram type and database), so the diagram's own syntax is Mermaid's to read. Kinds whose meaning is their
// layout (pie, gantt, gitGraph, block, quadrant, sankey, ...) are not told again and stay with Mermaid.

// The parts of Mermaid's per-diagram databases read here. Each getter is optional: a database without it
// is not the kind it claims to be, and yields no flowchart.
export interface ParsedDiagram {
  type: string;
  db: Record<string, unknown>;
}

type Lines = string[];

export function flowchartOf({ type, db }: ParsedDiagram): string | null {
  try {
    if (type === "c4") return c4(db);
    if (type === "mindmap") return mindmap(db);
    if (type === "architecture") return architecture(db);
    if (type === "requirement") return requirement(db);
    if (type === "timeline") return timeline(db);
  } catch {
    // A database of another shape than expected: Mermaid draws it.
  }
  return null;
}

function call<T>(db: Record<string, unknown>, name: string): T {
  const getter = db[name];
  if (typeof getter !== "function") throw new Error(`no ${name}`);
  return getter.call(db) as T;
}

// Ids in the flowchart are generated, so an id in the diagram can be anything.
class Ids {
  private readonly ids = new Map<string, string>();
  of(name: string): string {
    let id = this.ids.get(name);
    if (!id) {
      id = `n${this.ids.size}`;
      this.ids.set(name, id);
    }
    return id;
  }
  has(name: string): boolean {
    return this.ids.has(name);
  }
}

// A label as beautiful-mermaid reads it: lines joined by <br/>, long lines wrapped, and none of the characters
// that would end the label early (a quote, a square bracket).
export function label(parts: (string | undefined)[], width = 34): string {
  return parts
    .map((part) => (part ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .flatMap((part) => wrap(part, width))
    .map((line) => line.replace(/"/g, "'").replace(/\[/g, "(").replace(/\]/g, ")"))
    .join("<br/>");
}

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

function edgeLabel(parts: (string | undefined)[]): string {
  const text = label(parts, 28).replace(/\|/g, "/");
  return text ? `|"${text}"|` : "";
}

type Shape = "rect" | "rounded" | "stadium" | "cylinder" | "circle";

const SHAPES: Record<Shape, [string, string]> = {
  rect: ['["', '"]'],
  rounded: ['("', '")'],
  stadium: ['(["', '"])'],
  cylinder: ['[("', '")]'],
  circle: ['(("', '"))'],
};

// A shape closed by a parenthesis ends early at one in its label, so such a label goes in a plain box.
function node(id: string, text: string, shape: Shape = "rect"): string {
  const safe = shape === "rect" || !/[()]/.test(text) ? shape : "rect";
  const [open, close] = SHAPES[safe];
  return `${id}${open}${text}${close}`;
}

function text(value: unknown): string {
  if (value && typeof value === "object" && "text" in value) return String((value as { text: unknown }).text ?? "");
  return value == null ? "" : String(value);
}

// Nested groups as subgraphs: each group holds the lines of its members and its own subgroups.
function nest(out: Lines, groups: { id: string; title: string; parent: string }[], members: Map<string, string[]>, parent: string, indent: string) {
  for (const group of groups.filter((candidate) => candidate.parent === parent)) {
    out.push(`${indent}subgraph ${group.id} ["${label([group.title], 60)}"]`);
    for (const line of members.get(group.id) ?? []) out.push(`${indent}  ${line}`);
    nest(out, groups, members, group.id, `${indent}  `);
    out.push(`${indent}end`);
  }
}

const C4_KIND: Record<string, string> = {
  person: "Person",
  external_person: "Person, external",
  system: "System",
  system_db: "Database",
  system_queue: "Queue",
  external_system: "System, external",
  external_system_db: "Database, external",
  external_system_queue: "Queue, external",
  container: "Container",
  container_db: "Database",
  container_queue: "Queue",
  external_container: "Container, external",
  external_container_db: "Database, external",
  external_container_queue: "Queue, external",
  component: "Component",
  component_db: "Database",
  component_queue: "Queue",
  external_component: "Component, external",
  external_component_db: "Database, external",
  external_component_queue: "Queue, external",
};

interface C4Shape {
  alias: string;
  label?: unknown;
  descr?: unknown;
  techn?: unknown;
  typeC4Shape?: unknown;
  parentBoundary?: string;
}

interface C4Boundary {
  alias: string;
  label?: unknown;
  parentBoundary?: string;
}

interface C4Rel {
  type?: string;
  from: string;
  to: string;
  label?: unknown;
  techn?: unknown;
}

function c4(db: Record<string, unknown>): string {
  const shapes = call<C4Shape[]>(db, "getC4ShapeArray");
  const boundaries = call<C4Boundary[]>(db, "getBoundaries").filter((boundary) => boundary.alias !== "global");
  const rels = call<C4Rel[]>(db, "getRels");
  const ids = new Ids();
  const members = new Map<string, string[]>();
  const top: string[] = [];
  for (const shape of shapes) {
    const type = text(shape.typeC4Shape).toLowerCase();
    const kind = C4_KIND[type] ?? type;
    const techn = text(shape.techn);
    const line = node(
      ids.of(shape.alias),
      label([text(shape.label), techn ? `${kind}: ${techn}` : kind, text(shape.descr)]),
      type.includes("person") ? "stadium" : type.endsWith("_db") ? "cylinder" : "rect",
    );
    const parent = shape.parentBoundary && shape.parentBoundary !== "global" ? ids.of(`boundary:${shape.parentBoundary}`) : "";
    if (parent) members.set(parent, [...(members.get(parent) ?? []), line]);
    else top.push(line);
  }
  const groups = boundaries.map((boundary) => ({
    id: ids.of(`boundary:${boundary.alias}`),
    title: text(boundary.label),
    parent: boundary.parentBoundary && boundary.parentBoundary !== "global" ? ids.of(`boundary:${boundary.parentBoundary}`) : "",
  }));
  const out: Lines = ["flowchart TB", ...top.map((line) => `  ${line}`)];
  nest(out, groups, members, "", "  ");
  for (const rel of rels) {
    if (!ids.has(rel.from) || !ids.has(rel.to)) continue;
    const type = (rel.type ?? "").toLowerCase();
    const back = type === "rel_b" || type === "rel_back";
    const [from, to] = back ? [rel.to, rel.from] : [rel.from, rel.to];
    const arrow = type === "birel" ? "<-->" : "-->";
    out.push(`  ${ids.of(from)} ${arrow}${edgeLabel([text(rel.label), text(rel.techn)])} ${ids.of(to)}`);
  }
  return out.join("\n");
}

interface MindNode {
  descr?: string;
  children?: MindNode[];
}

function mindmap(db: Record<string, unknown>): string {
  const root = call<MindNode | undefined>(db, "getMindmap");
  if (!root) throw new Error("empty mindmap");
  const out: Lines = ["flowchart LR"];
  let count = 0;
  function visit(item: MindNode, parent: string | null) {
    const id = `n${count++}`;
    out.push(`  ${node(id, label([item.descr], 28), parent ? "rounded" : "stadium")}`);
    if (parent) out.push(`  ${parent} --- ${id}`);
    for (const child of item.children ?? []) visit(child, id);
  }
  visit(root, null);
  return out.join("\n");
}

interface ArchitectureItem {
  id: string;
  title?: string;
  icon?: string;
  in?: string;
}

interface ArchitectureEdge {
  lhsId: string;
  rhsId: string;
  lhsInto?: boolean;
  rhsInto?: boolean;
  title?: string;
}

function architecture(db: Record<string, unknown>): string {
  const services = call<ArchitectureItem[]>(db, "getServices");
  const junctions = call<ArchitectureItem[]>(db, "getJunctions");
  const groupList = call<ArchitectureItem[]>(db, "getGroups");
  const edges = call<ArchitectureEdge[]>(db, "getEdges");
  const ids = new Ids();
  const members = new Map<string, string[]>();
  const top: string[] = [];
  const place = (item: ArchitectureItem, line: string) => {
    if (item.in) {
      const parent = ids.of(`group:${item.in}`);
      members.set(parent, [...(members.get(parent) ?? []), line]);
    } else top.push(line);
  };
  for (const service of services) {
    const icon = (service.icon ?? "").toLowerCase();
    place(service, node(ids.of(service.id), label([service.title || service.id]), icon === "database" || icon === "disk" ? "cylinder" : icon === "internet" || icon === "cloud" ? "rounded" : "rect"));
  }
  for (const junction of junctions) place(junction, node(ids.of(junction.id), " ", "circle"));
  const groups = groupList.map((group) => ({ id: ids.of(`group:${group.id}`), title: group.title || group.id, parent: group.in ? ids.of(`group:${group.in}`) : "" }));
  const out: Lines = ["flowchart LR", ...top.map((line) => `  ${line}`)];
  nest(out, groups, members, "", "  ");
  for (const edge of edges) {
    if (!ids.has(edge.lhsId) || !ids.has(edge.rhsId)) continue;
    const lhs = ids.of(edge.lhsId);
    const rhs = ids.of(edge.rhsId);
    const title = edgeLabel([edge.title]);
    if (edge.lhsInto && edge.rhsInto) out.push(`  ${lhs} <-->${title} ${rhs}`);
    else if (edge.rhsInto) out.push(`  ${lhs} -->${title} ${rhs}`);
    else if (edge.lhsInto) out.push(`  ${rhs} -->${title} ${lhs}`);
    else out.push(`  ${lhs} ---${title} ${rhs}`);
  }
  return out.join("\n");
}

interface Requirement {
  name: string;
  type?: string;
  requirementId?: string;
  text?: string;
  risk?: string;
  verifyMethod?: string;
}

interface RequirementElement {
  name: string;
  type?: string;
  docRef?: string;
}

interface RequirementRelation {
  type?: string;
  src: string;
  dst: string;
}

function requirement(db: Record<string, unknown>): string {
  const requirements = call<Map<string, Requirement>>(db, "getRequirements");
  const elements = call<Map<string, RequirementElement>>(db, "getElements");
  const relations = call<RequirementRelation[]>(db, "getRelationships");
  const ids = new Ids();
  const out: Lines = ["flowchart TB"];
  for (const item of requirements.values()) {
    const facts = [item.requirementId && `Id: ${item.requirementId}`, item.text && `Text: ${item.text}`, item.risk && `Risk: ${item.risk}`, item.verifyMethod && `Verify: ${item.verifyMethod}`];
    out.push(`  ${node(ids.of(item.name), label([`«${item.type || "Requirement"}» ${item.name}`, ...facts]))}`);
  }
  for (const item of elements.values()) {
    out.push(`  ${node(ids.of(item.name), label([`«Element» ${item.name}`, item.type && `Type: ${item.type}`, item.docRef && `Doc: ${item.docRef}`]), "rounded")}`);
  }
  for (const relation of relations) {
    if (!ids.has(relation.src) || !ids.has(relation.dst)) continue;
    out.push(`  ${ids.of(relation.src)} -->${edgeLabel([relation.type])} ${ids.of(relation.dst)}`);
  }
  return out.join("\n");
}

interface TimelineTask {
  section?: string;
  task?: string;
  events?: string[];
}

function timeline(db: Record<string, unknown>): string {
  const sections = call<string[]>(db, "getSections");
  const tasks = call<TimelineTask[]>(db, "getTasks");
  if (!tasks.length) throw new Error("empty timeline");
  const out: Lines = ["flowchart LR"];
  const line = (task: TimelineTask, index: number) => node(`n${index}`, label([task.task, ...(task.events ?? [])], 26), "rounded");
  const loose = tasks.map((task, index) => ({ task, index })).filter(({ task }) => !task.section || !sections.includes(task.section));
  for (const { task, index } of loose) out.push(`  ${line(task, index)}`);
  sections.forEach((section, sectionIndex) => {
    const inSection = tasks.map((task, index) => ({ task, index })).filter(({ task }) => task.section === section);
    if (!inSection.length) return;
    out.push(`  subgraph s${sectionIndex} ["${label([section], 60)}"]`);
    for (const { task, index } of inSection) out.push(`    ${line(task, index)}`);
    out.push("  end");
  });
  for (let index = 1; index < tasks.length; index++) out.push(`  n${index - 1} --> n${index}`);
  return out.join("\n");
}
