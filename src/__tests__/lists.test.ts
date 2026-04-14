import { describe, it, expect } from "vitest";
import {
  parseListPrefix,
  stripListPrefix,
  addNestingTabs,
} from "../lists.js";

describe("parseListPrefix", () => {
  it("returns null for plain text", () => {
    expect(parseListPrefix("Hello world")).toBeNull();
  });

  it("detects unordered list item", () => {
    const info = parseListPrefix("- Item");
    expect(info).not.toBeNull();
    expect(info!.isOrdered).toBe(false);
    expect(info!.nestingLevel).toBe(0);
  });

  it("detects ordered list item", () => {
    const info = parseListPrefix("1. Item");
    expect(info).not.toBeNull();
    expect(info!.isOrdered).toBe(true);
    expect(info!.nestingLevel).toBe(0);
  });

  it("detects nested unordered (2 spaces)", () => {
    const info = parseListPrefix("  - Nested");
    expect(info).not.toBeNull();
    expect(info!.isOrdered).toBe(false);
    expect(info!.nestingLevel).toBe(1);
  });

  it("detects double nested (4 spaces)", () => {
    const info = parseListPrefix("    - Double nested");
    expect(info).not.toBeNull();
    expect(info!.nestingLevel).toBe(2);
  });

  it("caps nesting level at 2", () => {
    const info = parseListPrefix("      - Deep");
    expect(info).not.toBeNull();
    expect(info!.nestingLevel).toBe(2);
  });

  it("returns null for heading", () => {
    expect(parseListPrefix("# Heading")).toBeNull();
  });
});

describe("stripListPrefix", () => {
  it("strips unordered prefix", () => {
    expect(stripListPrefix("- Item text")).toBe("Item text");
  });

  it("strips ordered prefix", () => {
    expect(stripListPrefix("1. Item text")).toBe("Item text");
  });

  it("strips with indentation", () => {
    expect(stripListPrefix("  - Nested item")).toBe("Nested item");
  });

  it("leaves plain text unchanged", () => {
    expect(stripListPrefix("plain text")).toBe("plain text");
  });
});

describe("addNestingTabs", () => {
  it("adds no tabs for level 0", () => {
    expect(addNestingTabs("text", 0)).toBe("text");
  });

  it("adds one tab for level 1", () => {
    expect(addNestingTabs("text", 1)).toBe("\ttext");
  });

  it("adds two tabs for level 2", () => {
    expect(addNestingTabs("text", 2)).toBe("\t\ttext");
  });
});
