import React from "react";
import { create } from "react-test-renderer";
import { describe, expect, it } from "vitest";
import { Table, TableBody, TableCaption, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "./table";

describe("table primitives", () => {
  it("renders every table slot with caller classes preserved", () => {
    const renderer = create(
      <Table className="operator-table">
        <TableCaption className="caption-extra">Run history</TableCaption>
        <TableHeader className="header-extra">
          <TableRow className="header-row">
            <TableHead className="head-extra">Name</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody className="body-extra">
          <TableRow data-state="selected">
            <TableCell className="cell-extra">Nightly</TableCell>
          </TableRow>
        </TableBody>
        <TableFooter className="footer-extra">
          <TableRow>
            <TableCell>Total</TableCell>
          </TableRow>
        </TableFooter>
      </Table>,
    );

    expect(renderer.root.findByProps({ "data-slot": "table-container" }).props.className).toContain("overflow-x-auto");
    expect(renderer.root.findByProps({ "data-slot": "table" }).props.className).toContain("operator-table");
    expect(renderer.root.findByProps({ "data-slot": "table-caption" }).props.className).toContain("caption-extra");
    expect(renderer.root.findByProps({ "data-slot": "table-header" }).props.className).toContain("header-extra");
    expect(renderer.root.findByProps({ "data-slot": "table-body" }).props.className).toContain("body-extra");
    expect(renderer.root.findByProps({ "data-slot": "table-footer" }).props.className).toContain("footer-extra");
    expect(renderer.root.findByProps({ "data-slot": "table-head" }).props.className).toContain("head-extra");
    expect(
      renderer.root
        .findAll((node) => node.props["data-slot"] === "table-cell")
        .some((node) => String(node.props.className).includes("cell-extra")),
    ).toBe(true);
  });
});
