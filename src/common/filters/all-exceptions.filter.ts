import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Logger } from 'nestjs-pino';

export interface ErrorResponseBody {
  statusCode: number;
  message: string | string[];
  error?: string;
  path: string;
  method: string;
  timestamp: string;
}

/** Terminus health check payloads expose `status` and `details` and must be passed through unmodified. */
function isHealthCheckPayload(body: Record<string, unknown>): boolean {
  return 'status' in body && 'details' in body;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const requestContext = {
      method: request.method,
      url: request.originalUrl ?? request.url,
      ip: request.ip,
    };

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let body: unknown;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (exceptionResponse !== null && typeof exceptionResponse === 'object') {
        const payload = exceptionResponse as Record<string, unknown>;
        if (isHealthCheckPayload(payload)) {
          this.logRequestFailure(exception, requestContext, status, 'warn');
          response.status(status).json(payload);
          return;
        }
        body = {
          statusCode: status,
          ...payload,
          path: request.originalUrl ?? request.url,
          method: request.method,
          timestamp: new Date().toISOString(),
        };
      } else if (typeof exceptionResponse === 'string') {
        body = {
          statusCode: status,
          message: exceptionResponse,
          error: exception.name,
          path: request.originalUrl ?? request.url,
          method: request.method,
          timestamp: new Date().toISOString(),
        };
      }
    }

    if (body === undefined) {
      body = {
        statusCode: status,
        message: 'Internal server error',
        error: 'InternalServerError',
        path: request.originalUrl ?? request.url,
        method: request.method,
        timestamp: new Date().toISOString(),
      };
    }

    this.logRequestFailure(
      exception,
      requestContext,
      status,
      status >= HttpStatus.INTERNAL_SERVER_ERROR ? 'error' : 'warn',
    );

    response.status(status).json(body);
  }

  private logRequestFailure(
    exception: unknown,
    req: { method: string; url: string; ip?: string },
    status: number,
    level: 'error' | 'warn',
  ): void {
    const logPayload = { req, res: { statusCode: status } };
    if (level === 'error') {
      this.logger.error(
        { err: exception, ...logPayload },
        'Unhandled exception',
      );
    } else {
      this.logger.warn(logPayload, 'Request failed');
    }
  }
}
