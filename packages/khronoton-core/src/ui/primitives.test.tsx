// @vitest-environment jsdom
//
// Light render smoke for the zero-logic presentational shells. These carry no
// branching logic, so the contract we pin is "children/labels reach the DOM and
// the semantic element is right" — enough to catch an accidental self-closing
// shell that drops its content.

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

import {
  Card,
  Panel,
  Title,
  Table,
  Thead,
  Row,
  Cell,
  TextButton,
  LinkButton,
  Field,
  MetaCell,
  Badge,
} from "./primitives.js";

afterEach(() => {
  cleanup();
});

describe("layout shells", () => {
  it("renders Card/Panel children so screens can nest content in them", () => {
    render(
      <Card>
        <Panel>panel-body</Panel>
      </Card>,
    );
    expect(screen.getByText("panel-body")).toBeDefined();
  });

  it("renders a section Title with its text", () => {
    render(<Title>Fire history</Title>);
    expect(screen.getByText("Fire history")).toBeDefined();
  });
});

describe("Table primitives", () => {
  it("composes a real table element with a header cell and a body row/cell", () => {
    render(
      <Table>
        <Thead>
          <Row>
            <Cell as="th">Name</Cell>
          </Row>
        </Thead>
        <tbody>
          <Row>
            <Cell>Daily payout</Cell>
          </Row>
        </tbody>
      </Table>,
    );
    expect(screen.getByRole("table")).toBeDefined();
    expect(screen.getByText("Name").tagName).toBe("TH");
    expect(screen.getByText("Daily payout").tagName).toBe("TD");
  });
});

describe("buttons", () => {
  it("renders a TextButton as a button carrying its title and disabled state", () => {
    render(
      <TextButton disabled title="Ancient admins only">
        Delete
      </TextButton>,
    );
    const btn = screen.getByRole("button", { name: "Delete" });
    expect(btn.getAttribute("title")).toBe("Ancient admins only");
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders a LinkButton as an anchor pointing at its href", () => {
    render(<LinkButton href="/hub/codex-cronotons/1/edit">Edit</LinkButton>);
    const link = screen.getByRole("link", { name: "Edit" });
    expect(link.getAttribute("href")).toBe("/hub/codex-cronotons/1/edit");
  });
});

describe("labelled Field and MetaCell", () => {
  it("associates the Field label text with the input it wraps", () => {
    render(
      <Field label="Name">
        <input defaultValue="Daily payout" />
      </Field>,
    );
    expect(screen.getByText("Name")).toBeDefined();
    expect((screen.getByDisplayValue("Daily payout") as HTMLInputElement).tagName).toBe("INPUT");
  });

  it("renders a MetaCell label above its value for the metadata grid", () => {
    render(<MetaCell label="Status">active</MetaCell>);
    expect(screen.getByText("Status")).toBeDefined();
    expect(screen.getByText("active")).toBeDefined();
  });
});

describe("Badge base", () => {
  it("renders the badge content passed to it", () => {
    render(<Badge>paused</Badge>);
    expect(screen.getByText("paused")).toBeDefined();
  });
});
