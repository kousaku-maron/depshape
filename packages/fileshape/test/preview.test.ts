import { describe, expect, it } from "vitest";
import { HttpError } from "@diffshape/core";
import { safePath } from "../src/api.js";
import { imageUrl, resolvePath } from "../ui/src/MarkdownPreview";

describe("paths", () => {
  it("accepts only paths inside the repository", () => {
    expect(safePath("docs/a.png")).toBe("docs/a.png");
    for (const bad of ["", "/etc/passwd", "../x", "a/../../x", "a//b", "C:/x"]) expect(() => safePath(bad), bad).toThrow(HttpError);
  });

  it("resolves images of a Markdown file from its folder", () => {
    expect(resolvePath("docs/guide/README.md", "./img/a.png")).toBe("docs/guide/img/a.png");
    expect(resolvePath("docs/guide/README.md", "../shot.png")).toBe("docs/shot.png");
    expect(resolvePath("docs/README.md", "/assets/logo%20big.svg")).toBe("assets/logo big.svg");
    expect(resolvePath("README.md", "../../x.png")).toBeNull();
    expect(imageUrl("img/a.png?raw=1", "src", "docs/README.md", "new", 3)).toBe("/api/module/file/raw?path=docs%2Fimg%2Fa.png&side=new&v=3");
    expect(imageUrl("https://example.com/a.png", "src", "README.md", "new", 0)).toBe("https://example.com/a.png");
    expect(imageUrl("javascript:alert(1)", "href", "README.md", "new", 0)).toBe("");
  });
});
