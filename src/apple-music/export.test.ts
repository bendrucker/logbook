import { describe, expect, it, test } from "vitest";
import { parseCsv, project } from "./export";

describe("parseCsv", () => {
  test.each<{ name: string; text: string; expected: Record<string, string>[] }>([
    {
      name: "plain fields",
      text: "Song Name,Album Name\nCreep,Pablo Honey\n",
      expected: [{ "Song Name": "Creep", "Album Name": "Pablo Honey" }],
    },
    {
      name: "a quoted comma",
      text: '"Song Name","Album Name"\n"Hail to the Thief","Hail to the Thief, Live"\n',
      expected: [{ "Song Name": "Hail to the Thief", "Album Name": "Hail to the Thief, Live" }],
    },
    {
      name: "a doubled quote",
      text: 'Song Name\n"The ""Bends"""\n',
      expected: [{ "Song Name": 'The "Bends"' }],
    },
    {
      name: "a newline inside quotes",
      text: 'Song Name,Album Name\n"Line one\nline two",Kid A\n',
      expected: [{ "Song Name": "Line one\nline two", "Album Name": "Kid A" }],
    },
    {
      name: "CRLF line endings and no trailing newline",
      text: "Song Name,Album Name\r\nCreep,Pablo Honey\r\nAirbag,OK Computer",
      expected: [
        { "Song Name": "Creep", "Album Name": "Pablo Honey" },
        { "Song Name": "Airbag", "Album Name": "OK Computer" },
      ],
    },
    {
      name: "an empty cell",
      text: "Song Name,Album Name\nCreep,\n",
      expected: [{ "Song Name": "Creep", "Album Name": "" }],
    },
  ])("reads $name", ({ text, expected }) => {
    expect(parseCsv(text)).toEqual(expected);
  });
});

describe("parseCsv errors", () => {
  test.each<{ name: string; text: string; message: string }>([
    {
      name: "an unclosed quote",
      text: 'Song Name,Album Name\n"Creep,Pablo Honey\n',
      message: "the CSV ends inside a quoted field",
    },
    {
      name: "a short row",
      text: "Song Name,Album Name\nCreep\n",
      message: "CSV row 1 has 1 fields where the header has 2",
    },
    {
      name: "a long row",
      text: "Song Name,Album Name\nCreep,Pablo Honey,1993\n",
      message: "CSV row 1 has 3 fields where the header has 2",
    },
  ])("refuses $name", ({ text, message }) => {
    expect(() => parseCsv(text)).toThrow(message);
  });
});

describe("project", () => {
  it("drops every column outside the allowlist", () => {
    const projected = project("play-activity", {
      "Event ID": "e1",
      "Song Name": "Creep",
      "Client IP Address": "192.0.2.1",
      "IP Latitude": "37.7",
      "Device Identifier": "device",
      "Apple ID Number": "123",
    });

    expect(Object.keys(projected)).not.toContain("Client IP Address");
    expect(Object.keys(projected)).not.toContain("IP Latitude");
    expect(Object.keys(projected)).not.toContain("Device Identifier");
    expect(Object.keys(projected)).not.toContain("Apple ID Number");
    expect(projected).toMatchObject({ "Event ID": "e1", "Song Name": "Creep" });
  });

  it("writes an empty or missing cell as null", () => {
    const projected = project("favorites", { "Favorite Type": "Song", Preference: "" });

    expect(projected).toEqual({
      "Favorite Type": "Song",
      "Item Reference": null,
      "Item Description": null,
      "Last Modified": null,
      Preference: null,
    });
  });
});
