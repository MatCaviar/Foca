/**
 * Lesson store: cross-session memory of verified reframes (protocol 6).
 * Retrieval matches at the {@link FamilyClass} level so a lesson mined on one
 * deployment (a car head unit) transfers to another (a web backend) — the
 * store never keys on tool names.
 * @module @deepseek-ai/dsh-blockade
 */

import type { FamilyClass, Lesson } from './domain.ts'

/** In-process lesson store exposed as `ctx.blockadeLessons`. */
export class BlockadeLessonStore {
  private readonly lessons: Lesson[] = []

  /**
   * Commit a lesson unless an equivalent one exists (same avoid set and
   * worked class). Duplicates from repeated breakthroughs collapse.
   * @param lesson - the extracted lesson.
   * @returns true when the store changed.
   */
  record(lesson: Lesson): boolean {
    const duplicate = this.lessons.some(existing =>
      existing.workedClass === lesson.workedClass
      && setEquals(new Set(existing.avoidClasses), new Set(lesson.avoidClasses)))
    if (duplicate) return false
    this.lessons.push(lesson)
    return true
  }

  /**
   * Every committed lesson, oldest first.
   * @returns the committed lessons in commit order.
   */
  all(): readonly Lesson[] {
    return this.lessons
  }

  /**
   * Lessons relevant to a set of family classes the caller is about to use:
   * any lesson whose avoid set intersects the classes.
   * @param classes - family classes mapped for the upcoming work.
   * @returns lessons whose avoid set intersects the classes.
   */
  relevantTo(classes: readonly FamilyClass[]): readonly Lesson[] {
    const used = new Set(classes)
    return this.lessons.filter(lesson => lesson.avoidClasses.some(avoid => used.has(avoid)))
  }

  /**
   * Compact one-line rendering for the recall directive.
   * @param lessons - the lessons to render.
   * @returns one line per lesson, joined with separators.
   */
  static render(lessons: readonly Lesson[]): string {
    return lessons
      .map(lesson => `in similar environments ${lesson.summary}; prefer ${lesson.workedClass} early and verify its effect independently`)
      .join(' | ')
  }
}

function setEquals(a: Set<FamilyClass>, b: Set<FamilyClass>): boolean {
  if (a.size !== b.size) return false
  for (const value of a) {
    if (!b.has(value)) return false
  }
  return true
}
