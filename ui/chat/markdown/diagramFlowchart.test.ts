import { after, test } from "node:test";
import assert from "node:assert/strict";
import { installDom } from "../../testing/dom.ts";

// Mermaid parses in a happy-dom window, so the converters read the databases the page would.
const dom = installDom();
const mermaid = (await import("mermaid")).default;
const { flowchartOf, label } = await import("./diagramFlowchart.ts");
mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });

after(async () => {
  await dom.happyDOM.abort();
  dom.close();
});

async function flowchart(text: string) {
  const { type, db } = await mermaid.mermaidAPI.getDiagramFromText(text);
  return flowchartOf({ type, db: db as unknown as Record<string, unknown> });
}

test("a C4 diagram becomes boxes in its boundaries, with its relations as arrows", async () => {
  const text = [
    "C4Container",
    "  title Sys",
    '  Person(u, "User", "A person")',
    '  System_Boundary(b, "App") {',
    '    Container(ui, "UI", "React", "Shows things")',
    '    ContainerDb(db, "DB", "SQLite")',
    "  }",
    '  System_Ext(x, "Ext")',
    '  Rel(u, ui, "Uses", "HTTPS")',
    '  BiRel(ui, x, "Talks")',
    '  Rel_Back(db, ui, "Reads")',
  ].join("\n");
  assert.equal(
    await flowchart(text),
    [
      "flowchart TB",
      '  n0(["User<br/>Person<br/>A person"])',
      '  n4["Ext<br/>System, external"]',
      '  subgraph n2 ["App"]',
      '    n1["UI<br/>Container: React<br/>Shows things"]',
      '    n3[("DB<br/>Database: SQLite")]',
      "  end",
      '  n0 -->|"Uses<br/>HTTPS"| n1',
      '  n1 <-->|"Talks"| n4',
      '  n1 -->|"Reads"| n3',
    ].join("\n"),
  );
});

test("a mindmap becomes a tree", async () => {
  assert.equal(
    await flowchart("mindmap\n  root((App))\n    UI\n      React\n    Host"),
    'flowchart LR\n  n0(["App"])\n  n1("UI")\n  n0 --- n1\n  n2("React")\n  n1 --- n2\n  n3("Host")\n  n0 --- n3',
  );
});

test("an architecture diagram keeps its groups and the direction of its arrows", async () => {
  const text = "architecture-beta\n  group api(cloud)[API]\n  service db(database)[Database] in api\n  service server(server)[Server] in api\n  service disk(disk)[Storage]\n  db:L -- R:server\n  disk:T --> B:db";
  assert.equal(
    await flowchart(text),
    'flowchart LR\n  n3[("Storage")]\n  subgraph n1 ["API"]\n    n0[("Database")]\n    n2["Server"]\n  end\n  n0 --- n2\n  n3 --> n0',
  );
});

test("a requirement diagram lists each requirement's facts", async () => {
  const text = "requirementDiagram\n  requirement r1 {\n    id: 1\n    text: must work\n    risk: high\n    verifymethod: test\n  }\n  element e1 {\n    type: sim\n  }\n  e1 - satisfies -> r1";
  assert.equal(
    await flowchart(text),
    'flowchart TB\n  n0["«Requirement» r1<br/>Id: 1<br/>Text: must work<br/>Risk: High<br/>Verify: Test"]\n  n1("«Element» e1<br/>Type: sim")\n  n1 -->|"satisfies"| n0',
  );
});

test("a timeline is a chain of periods in their sections", async () => {
  assert.equal(
    await flowchart("timeline\n  title History\n  section Early\n    2020 : Start : Idea\n    2021 : Build\n  section Late\n    2023 : Ship"),
    'flowchart LR\n  subgraph s0 ["Early"]\n    n0("2020<br/>Start<br/>Idea")\n    n1("2021<br/>Build")\n  end\n  subgraph s1 ["Late"]\n    n2("2023<br/>Ship")\n  end\n  n0 --> n1\n  n1 --> n2',
  );
});

test("kinds whose layout is their meaning stay with Mermaid", async () => {
  assert.equal(await flowchart('pie\n  "a" : 1'), null);
  assert.equal(await flowchart("gantt\n  title T\n  section S\n    Task :a1, 2026-01-01, 3d"), null);
  assert.equal(await flowchart("gitGraph\n  commit\n  branch dev\n  commit"), null);
});

test("labels are wrapped and keep clear of the characters that end them", () => {
  assert.equal(label(['Say "hi" [now]']), "Say 'hi' (now)");
  assert.equal(label(["one two three four five six seven eight nine ten"], 20), "one two three four<br/>five six seven eight<br/>nine ten");
  assert.equal(label(["Name", undefined, "", "Desc"]), "Name<br/>Desc");
});
