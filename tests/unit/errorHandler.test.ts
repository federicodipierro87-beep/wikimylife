import { errorBodySchema } from "@wikimylife/shared";
import type { NextFunction, Request, Response } from "express";
import { describe, expect, it } from "vitest";
import { AppError } from "../../apps/api/src/errors/AppError.js";
import { createErrorHandler, notFoundHandler } from "../../apps/api/src/errors/errorHandler.js";
import { createLogger } from "../../apps/api/src/logger.js";

/**
 * `errorHandler`.
 *
 * Il punto in cui si decide cosa esce dal processo. Le due proprieta' che
 * contano: ogni corpo rispetta `errorBodySchema` (lo stesso schema che il
 * client di shared usa per interpretare gli errori), e nessuno stack trace
 * finisce nella risposta.
 */

interface Captured {
  status: number | null;
  body: unknown;
  stdout: string[];
  stderr: string[];
}

function harness(): {
  handle: (error: unknown) => void;
  handleNotFound: () => void;
  captured: Captured;
} {
  const captured: Captured = { status: null, body: null, stdout: [], stderr: [] };

  const logger = createLogger({
    level: "debug",
    write: (line) => captured.stdout.push(line),
    writeError: (line) => captured.stderr.push(line),
  });

  const res = {
    headersSent: false,
    getHeader: (): string => "req-test-1",
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(payload: unknown) {
      captured.body = payload;
      return this;
    },
  } as unknown as Response;

  const req = { method: "POST", path: "/api/auth/login" } as unknown as Request;
  const next = (() => undefined) as unknown as NextFunction;
  const errorHandler = createErrorHandler(logger);

  return {
    handle: (error: unknown) => {
      errorHandler(error, req, res, next);
    },
    handleNotFound: () => {
      notFoundHandler(req, res);
    },
    captured,
  };
}

describe("errorHandler con AppError", () => {
  it("usa lo stato e il codice dell'errore", () => {
    const h = harness();
    h.handle(AppError.tokenReused());

    expect(h.captured.status).toBe(401);
    expect(h.captured.body).toEqual({
      error: {
        code: "TOKEN_REUSED",
        message: "Refresh token gia' utilizzato: la sessione e' stata revocata",
      },
    });
  });

  it("il corpo rispetta errorBodySchema", () => {
    const h = harness();
    h.handle(AppError.invalidCredentials());

    expect(errorBodySchema.safeParse(h.captured.body).success).toBe(true);
  });

  it("include details solo per VALIDATION_FAILED", () => {
    const h = harness();
    h.handle(
      AppError.validationFailed([{ path: ["email"], message: "Email non valida" }]),
    );

    expect(h.captured.status).toBe(400);
    expect(errorBodySchema.parse(h.captured.body).error.details).toEqual([
      { path: ["email"], message: "Email non valida" },
    ]);
  });

  it("non espone details sugli errori di autenticazione", () => {
    // Un `details` su un errore di auth sarebbe stato interno regalato: quale
    // controllo e' fallito, quindi quale ha superato.
    const h = harness();
    h.handle(AppError.tokenExpired());

    expect(errorBodySchema.parse(h.captured.body).error.details).toBeUndefined();
  });

  it("non mette il context nella risposta", () => {
    const h = harness();
    h.handle(
      new AppError({
        code: "NOT_FOUND",
        message: "Risorsa non trovata",
        status: 404,
        context: { userId: "u-1", queryInterna: "SELECT ..." },
      }),
    );

    expect(JSON.stringify(h.captured.body)).not.toContain("queryInterna");
    expect(JSON.stringify(h.captured.body)).not.toContain("u-1");
  });

  it("logga il context accanto al requestId", () => {
    const h = harness();
    h.handle(
      new AppError({
        code: "NOT_FOUND",
        message: "Risorsa non trovata",
        status: 404,
        context: { procedureId: "p-9" },
      }),
    );

    const logged = h.captured.stdout.join("\n");
    expect(logged).toContain("req-test-1");
    expect(logged).toContain("p-9");
  });
});

describe("errorHandler con un errore imprevisto", () => {
  it("risponde 500 con un messaggio fisso", () => {
    const h = harness();
    h.handle(new Error("connect ECONNREFUSED 10.0.3.14:5432"));

    expect(h.captured.status).toBe(500);
    expect(h.captured.body).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Errore interno del server" },
    });
  });

  it("non fa uscire il messaggio originale", () => {
    // Un messaggio di driver contiene indirizzi interni, nomi di host, a volte
    // pezzi di query.
    const h = harness();
    h.handle(new Error("connect ECONNREFUSED 10.0.3.14:5432"));

    expect(JSON.stringify(h.captured.body)).not.toContain("10.0.3.14");
  });

  it("non fa uscire lo stack, ma lo scrive su stderr col requestId", () => {
    const h = harness();
    h.handle(new Error("qualcosa e' esploso"));

    expect(JSON.stringify(h.captured.body)).not.toContain("stack");
    const stderr = h.captured.stderr.join("\n");
    expect(stderr).toContain("req-test-1");
    expect(stderr).toContain("qualcosa e' esploso");
  });

  it("sopravvive a un throw che non e' un Error", () => {
    const h = harness();
    h.handle("stringa lanciata a caso");

    expect(h.captured.status).toBe(500);
    expect(errorBodySchema.safeParse(h.captured.body).success).toBe(true);
  });

  it("il corpo del 500 rispetta lo schema", () => {
    const h = harness();
    h.handle(new Error("x"));

    expect(errorBodySchema.safeParse(h.captured.body).success).toBe(true);
  });
});

describe("notFoundHandler", () => {
  it("usa la stessa forma di tutti gli altri errori", () => {
    const h = harness();
    h.handleNotFound();

    expect(h.captured.status).toBe(404);
    expect(errorBodySchema.parse(h.captured.body).error.code).toBe("NOT_FOUND");
  });
});
