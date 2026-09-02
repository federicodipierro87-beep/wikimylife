import { ErrorCode, type ErrorBody } from "@wikimylife/shared";
import type { NextFunction, Request, Response } from "express";
import type { Logger } from "../logger.js";
import { AppError } from "./AppError.js";

/**
 * Unico punto in cui un errore diventa una risposta HTTP.
 *
 * Due categorie, trattate in modo opposto:
 *   - `AppError`: previsto, il messaggio e' pensato per essere letto;
 *   - tutto il resto: 500 con messaggio fisso. Lo stack va su stderr con il
 *     requestId, cosi' e' rintracciabile senza essere pubblicato.
 *
 * Express 5 propaga da solo i rejection dei handler async: nessun
 * `asyncHandler` da ricordarsi di avvolgere, quindi nessun handler che per
 * distrazione resta scoperto.
 */
export function createErrorHandler(logger: Logger) {
  return function errorHandler(
    error: unknown,
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    if (res.headersSent) {
      next(error);
      return;
    }

    const requestId = res.getHeader("x-request-id");

    if (error instanceof AppError) {
      logger.warn("richiesta rifiutata", {
        requestId,
        method: req.method,
        path: req.path,
        code: error.code,
        status: error.status,
        ...(error.context ?? {}),
      });

      const body: ErrorBody = {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: [...error.details] }),
        },
      };
      res.status(error.status).json(body);
      return;
    }

    logger.error("errore non gestito", {
      requestId,
      method: req.method,
      path: req.path,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    const body: ErrorBody = {
      error: {
        code: ErrorCode.INTERNAL_ERROR,
        message: "Errore interno del server",
      },
    };
    res.status(500).json(body);
  };
}

/** 404 di default: stessa forma di tutti gli altri errori. */
export function notFoundHandler(_req: Request, res: Response): void {
  const body: ErrorBody = {
    error: {
      code: ErrorCode.NOT_FOUND,
      message: "Endpoint non trovato",
    },
  };
  res.status(404).json(body);
}
