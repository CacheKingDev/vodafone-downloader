import { describe, expect, it } from "vitest";
import {
  cookieHeader,
  mergeCookies,
  parseCookieJar,
  parseSetCookiePairs,
  serializeCookies,
} from "./cookie-jar.js";

describe("parseSetCookiePairs", () => {
  it("extracts name/value, ignoring attributes", () => {
    expect(
      parseSetCookiePairs(["sess=abc123; Path=/; HttpOnly", "id=xyz; Max-Age=3600"]),
    ).toEqual([
      { name: "sess", value: "abc123" },
      { name: "id", value: "xyz" },
    ]);
  });

  it("skips an entry with no '='", () => {
    expect(parseSetCookiePairs(["broken"])).toEqual([]);
  });
});

describe("mergeCookies", () => {
  it("overwrites a cookie with the same name in place, keeping the rest", () => {
    const base = [
      { name: "a", value: "1" },
      { name: "b", value: "2" },
    ];
    const incoming = [
      { name: "b", value: "3" },
      { name: "c", value: "4" },
    ];
    expect(mergeCookies(base, incoming)).toEqual([
      { name: "a", value: "1" },
      { name: "b", value: "3" },
      { name: "c", value: "4" },
    ]);
  });
});

describe("cookieHeader", () => {
  it("serialises the jar as a Cookie header value", () => {
    expect(
      cookieHeader([
        { name: "a", value: "1" },
        { name: "b", value: "2" },
      ]),
    ).toBe("a=1; b=2");
  });
});

describe("serializeCookies / parseCookieJar", () => {
  it("round-trips a jar through JSON", () => {
    const jar = [{ name: "a", value: "1" }];
    expect(parseCookieJar(serializeCookies(jar))).toEqual(jar);
  });

  it("rejects malformed JSON", () => {
    expect(() => parseCookieJar("not json")).toThrow();
  });

  it("rejects a JSON value that is not an array", () => {
    expect(() => parseCookieJar('{"a":1}')).toThrow();
  });

  it("rejects an array entry missing name or value", () => {
    expect(() => parseCookieJar('[{"name":"a"}]')).toThrow();
  });
});
