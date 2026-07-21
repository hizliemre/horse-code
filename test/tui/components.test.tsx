import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { Board, PhaseBar, Prompt, App } from "../../src/tui/components.js";
import { TuiController } from "../../src/tui/controller.js";

describe("Ink bileşenleri", () => {
  it("Board kart title'larını ve kolon başlıklarını gösterir", () => {
    const { lastFrame } = render(
      <Board cards={[
        { id: "1", title: "Alfa", column: "TODO" },
        { id: "2", title: "Beta", column: "DONE" },
      ]} />,
    );
    const f = lastFrame() ?? "";
    expect(f).toContain("TODO");
    expect(f).toContain("DONE");
    expect(f).toContain("Alfa");
    expect(f).toContain("Beta");
  });

  it("PhaseBar fazı ve detayı gösterir", () => {
    const { lastFrame } = render(<PhaseBar phase="waves" detail="running" />);
    const f = lastFrame() ?? "";
    expect(f).toContain("waves");
    expect(f).toContain("running");
  });

  it("Prompt soruyu ve girdi işaretçisini gösterir", () => {
    const { lastFrame } = render(<Prompt question="Devam?" onSubmit={() => {}} />);
    const f = lastFrame() ?? "";
    expect(f).toContain("Devam?");
    expect(f).toContain(">");
  });

  it("App başlangıç state'ini render eder (faz + kartlar)", () => {
    const c = new TuiController();
    c.onEvent({ kind: "phase", phase: "board" });
    c.onEvent({ kind: "board", cards: [{ id: "1", title: "Görev", column: "IN-PROGRESS" }] });
    const { lastFrame } = render(<App controller={c} />);
    const f = lastFrame() ?? "";
    expect(f).toContain("board");
    expect(f).toContain("Görev");
  });

  it("App pending soru varsa Prompt render eder", () => {
    const c = new TuiController();
    void c.ask("Onaylıyor musun?");
    const { lastFrame } = render(<App controller={c} />);
    expect(lastFrame() ?? "").toContain("Onaylıyor musun?");
  });
});
