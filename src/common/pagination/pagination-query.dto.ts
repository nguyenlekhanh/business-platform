import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import type { SortDirection } from './cursor';

/**
 * Shared pagination query parameters for all tenant-scoped list endpoints.
 *
 * CONTRACT (approved in the Phase 2J assessment):
 * - limit: 1..100, default applied by services (DEFAULT_PAGE_SIZE = 20);
 *   anything outside the range is rejected with 400 by these validators.
 * - cursor: opaque continuation token from a previous page's
 *   `meta.nextCursor`; structural validation happens at decode time and maps
 *   to 400 - never 500.
 * - order: primary sort direction; the unique `id` tiebreaker always follows
 *   the same direction. Default 'asc' preserves historical list ordering.
 *
 * The controller-level ValidationPipe (whitelist + forbidNonWhitelisted +
 * transform) rejects unknown query fields with 400, so this DTO doubles as
 * the query allow-list. NOTE: query params arrive as strings - @Type(() =>
 * Number) coerces `limit` before @IsInt runs.
 */
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;
export const SORT_DIRECTIONS = ['asc', 'desc'] as const;

export class PageQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @IsIn(SORT_DIRECTIONS)
  order?: SortDirection;
}
