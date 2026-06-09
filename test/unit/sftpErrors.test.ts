import { describe, expect, it } from "vitest";
import { classifySftpError } from "../../src/ssh/sftpErrors";

describe("classifySftpError", () => {
  it("maps SFTP numeric status codes", () => {
    expect(classifySftpError({ code: 2 })).toBe("FileNotFound");
    expect(classifySftpError({ code: 3 })).toBe("NoPermissions");
    expect(classifySftpError({ code: 7 })).toBe("Unavailable");
  });

  it("maps node errno strings", () => {
    expect(classifySftpError({ code: "ENOENT" })).toBe("FileNotFound");
    expect(classifySftpError({ code: "EACCES" })).toBe("NoPermissions");
    expect(classifySftpError({ code: "EEXIST" })).toBe("FileExists");
    expect(classifySftpError({ code: "ETIMEDOUT" })).toBe("Unavailable");
  });

  it("falls back to message text", () => {
    expect(classifySftpError(new Error("No such file or directory"))).toBe("FileNotFound");
    expect(classifySftpError(new Error("Permission denied"))).toBe("NoPermissions");
  });

  it("returns Unknown for unrecognized input", () => {
    expect(classifySftpError(undefined)).toBe("Unknown");
    expect(classifySftpError({})).toBe("Unknown");
    expect(classifySftpError("oops")).toBe("Unknown");
  });
});
