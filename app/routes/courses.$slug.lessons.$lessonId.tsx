import { useState, useEffect, useCallback } from "react";
import { Link, useFetcher, useNavigate } from "react-router";
import { toast } from "sonner";
import type { Route } from "./+types/courses.$slug.lessons.$lessonId";
import {
  getCourseBySlug,
  getCourseWithDetails,
} from "~/services/courseService";
import { getLessonById } from "~/services/lessonService";
import { getModuleById } from "~/services/moduleService";
import { getCurrentUserId } from "~/lib/session";
import { getUserById } from "~/services/userService";
import { isUserEnrolled } from "~/services/enrollmentService";
import { completeLesson } from "~/services/lessonCompletionService";
import {
  countTopLevelComments,
  getCommentThreads,
  createComment,
  createReply,
  editComment,
  deleteComment,
  moderateDeleteComment,
  getComment,
  type CommentThread,
} from "~/services/commentService";
import {
  getLessonProgress,
  getLessonProgressForCourse,
  markLessonInProgress,
} from "~/services/progressService";
import {
  getLastWatchPosition,
  calculateWatchProgress,
} from "~/services/videoTrackingService";
import {
  getQuizByLessonId,
  getQuizWithQuestions,
  getBestAttempt,
} from "~/services/quizService";
import {
  getBookmarkedLessonIds,
  isLessonBookmarked,
  toggleBookmark,
} from "~/services/bookmarkService";
import { computeResult } from "~/services/quizScoringService";
import { awardQuizFirstPassXp } from "~/services/gamificationService";
import { LessonProgressStatus, UserRole } from "~/db/schema";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { Card, CardContent } from "~/components/ui/card";
import {
  AlertTriangle,
  Bookmark,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  Clock,
  Github,
  HelpCircle,
  MapPin,
  MessageSquare,
  Pencil,
  PlayCircle,
  Reply,
  ShieldAlert,
  Trash2,
  XCircle,
  Trophy,
  RotateCcw,
} from "lucide-react";
import { cn, formatDuration } from "~/lib/utils";
import { renderMarkdown, renderCommentMarkdown } from "~/lib/markdown.server";
import { UserAvatar } from "~/components/user-avatar";
import { YouTubePlayer } from "~/components/youtube-player";
import { data, isRouteErrorResponse, redirect } from "react-router";
import { z } from "zod";
import { resolveCountry } from "~/lib/country.server";
import { checkPppAccess, COUNTRIES } from "~/lib/ppp";
import { findPurchase } from "~/services/purchaseService";
import { parseFormData, parseParams } from "~/lib/validation";

const lessonParamsSchema = z.object({
  slug: z.string().min(1),
  lessonId: z.coerce.number().int(),
});

const markCompleteSchema = z.object({
  intent: z.literal("mark-complete"),
});

// ─── Comments ───

const COMMENTS_PAGE_SIZE = 5;

const commentBodySchema = z
  .string()
  .trim()
  .min(1, "Comment cannot be empty.")
  .max(5000, "Comment cannot exceed 5000 characters.");

const createCommentSchema = z.object({
  intent: z.literal("create-comment"),
  body: commentBodySchema,
  parentId: z.coerce.number().int().optional(),
});

const editCommentSchema = z.object({
  intent: z.literal("edit-comment"),
  commentId: z.coerce.number().int(),
  body: commentBodySchema,
});

const deleteCommentSchema = z.object({
  intent: z.literal("delete-comment"),
  commentId: z.coerce.number().int(),
  // Optional moderation reason; only used when a moderator removes another
  // user's comment.
  reason: z.string().trim().max(500).optional(),
});

const loadCommentsSchema = z.object({
  intent: z.literal("load-comments"),
  offset: z.coerce.number().int().min(0),
});

// The per-viewer view of a comment. Permissions and rendered HTML are computed
// server-side so the same shape flows from both the loader (first page) and the
// load-comments action (subsequent pages).
export type CommentView = {
  id: number;
  parentId: number | null;
  authorId: number;
  authorName: string;
  authorAvatarUrl: string | null;
  authorIsCourseInstructor: boolean;
  authorIsAdmin: boolean;
  bodyHtml: string | null;
  rawBody: string | null;
  isDeleted: boolean;
  removalReason: string | null;
  createdAt: string;
  edited: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canModerate: boolean;
  replies: CommentView[];
};

type ViewerContext = {
  userId: number;
  isAdmin: boolean;
  canModerate: boolean;
  courseInstructorId: number;
};

async function commentRowToView(
  row: CommentThread["replies"][number],
  viewer: ViewerContext
): Promise<CommentView> {
  const isDeleted = row.deletedAt !== null;
  const isAuthor = viewer.userId === row.authorId;
  const canEdit = isAuthor && !isDeleted;
  const reasonVisible =
    (isAuthor || viewer.isAdmin) && row.removalReason
      ? row.removalReason
      : null;

  return {
    id: row.id,
    parentId: row.parentId,
    authorId: row.authorId,
    authorName: row.authorName,
    authorAvatarUrl: row.authorAvatarUrl,
    authorIsCourseInstructor: row.authorId === viewer.courseInstructorId,
    authorIsAdmin: row.authorRole === UserRole.Admin,
    bodyHtml: isDeleted ? null : await renderCommentMarkdown(row.body),
    rawBody: canEdit ? row.body : null,
    isDeleted,
    removalReason: reasonVisible,
    createdAt: row.createdAt,
    edited:
      !isDeleted &&
      new Date(row.updatedAt).getTime() > new Date(row.createdAt).getTime(),
    canEdit,
    canDelete: canEdit,
    canModerate: viewer.canModerate && !isAuthor && !isDeleted,
    replies: [],
  };
}

// Builds one page of comment views (top-level threads + their replies).
async function buildCommentViews(
  lessonId: number,
  viewer: ViewerContext,
  offset: number
): Promise<{ threads: CommentView[]; hasMore: boolean }> {
  const threads = getCommentThreads(lessonId, COMMENTS_PAGE_SIZE, offset);
  const views = await Promise.all(
    threads.map(async (thread) => {
      const top = await commentRowToView(thread, viewer);
      top.replies = await Promise.all(
        thread.replies.map((reply) => commentRowToView(reply, viewer))
      );
      return top;
    })
  );

  const total = countTopLevelComments(lessonId);
  return { threads: views, hasMore: offset + threads.length < total };
}

export function meta({ data: loaderData }: Route.MetaArgs) {
  const title = loaderData?.lesson?.title ?? "Lesson";
  const courseTitle = loaderData?.course?.title ?? "Course";
  return [{ title: `${title} — ${courseTitle} — Cadence` }];
}

type FlatLesson = {
  id: number;
  title: string;
  moduleId: number;
  moduleTitle: string;
};

function flattenCourseLessons(course: {
  modules: Array<{
    id: number;
    title: string;
    lessons: Array<{ id: number; title: string; moduleId: number }>;
  }>;
}): FlatLesson[] {
  const flat: FlatLesson[] = [];
  for (const mod of course.modules) {
    for (const lesson of mod.lessons) {
      flat.push({
        id: lesson.id,
        title: lesson.title,
        moduleId: mod.id,
        moduleTitle: mod.title,
      });
    }
  }
  return flat;
}

export async function loader({ params, request }: Route.LoaderArgs) {
  const slug = params.slug;
  const lessonId = Number(params.lessonId);

  if (isNaN(lessonId)) {
    throw data("Invalid lesson ID", { status: 400 });
  }

  const course = getCourseBySlug(slug);
  if (!course) {
    throw data("Course not found", { status: 404 });
  }

  const courseWithDetails = getCourseWithDetails(course.id);
  if (!courseWithDetails) {
    throw data("Course not found", { status: 404 });
  }

  const lesson = getLessonById(lessonId);
  if (!lesson) {
    throw data("Lesson not found", { status: 404 });
  }

  const mod = getModuleById(lesson.moduleId);
  if (!mod) {
    throw data("Module not found", { status: 404 });
  }

  // Verify lesson belongs to this course
  if (mod.courseId !== course.id) {
    throw data("Lesson not found in this course", { status: 404 });
  }

  const currentUserId = await getCurrentUserId(request);

  // ─── Lesson access guard ───
  // Lesson material (video + written content) is gated: only enrolled
  // students, the course instructor, and admins may view it. Anyone else —
  // including anonymous visitors — is redirected to the course landing page
  // where they can enroll. This runs before any lesson content is loaded or
  // rendered, so the material can't be read by guessing the lesson URL.
  const currentUser = currentUserId ? getUserById(currentUserId) : null;
  const isAdmin = currentUser?.role === UserRole.Admin;
  const isCourseInstructor =
    !!currentUserId && course.instructorId === currentUserId;
  const enrolled = !!currentUserId && isUserEnrolled(currentUserId, course.id);

  if (!enrolled && !isAdmin && !isCourseInstructor) {
    throw redirect(`/courses/${slug}`);
  }

  let lessonStatus: string | null = null;
  let lastWatchPosition = 0;
  let watchProgress = 0;
  let lessonProgressMap: Record<number, string> = {};
  let bookmarkedLessonIds: number[] = [];
  let isBookmarked = false;

  if (enrolled && currentUserId) {
    // Mark lesson as in-progress when viewed
    markLessonInProgress(currentUserId, lessonId);
    const progress = getLessonProgress(currentUserId, lessonId);
    lessonStatus = progress?.status ?? null;

    // Bookmarks: current lesson state + all bookmarked lessons (for sidebar)
    bookmarkedLessonIds = getBookmarkedLessonIds({
      userId: currentUserId,
      courseId: course.id,
    });
    isBookmarked = isLessonBookmarked({ userId: currentUserId, lessonId });

    // Get progress for all lessons in course (for curriculum sidebar)
    const progressRecords = getLessonProgressForCourse(
      currentUserId,
      course.id
    );
    for (const record of progressRecords) {
      lessonProgressMap[record.lessonId] = record.status;
    }

    // Get video watch state for resume and progress display
    if (lesson.videoUrl) {
      lastWatchPosition = getLastWatchPosition(currentUserId, lessonId);
      const videoDurationSeconds = (lesson.durationMinutes ?? 0) * 60;
      if (videoDurationSeconds > 0) {
        watchProgress = calculateWatchProgress(
          currentUserId,
          lessonId,
          videoDurationSeconds
        );
      }
    }
  }

  // PPP Access Guard
  let pppBlocked = false;
  let pppBlockedCountry: string | null = null;
  let pppPurchaseCountry: string | null = null;

  if (enrolled && currentUserId) {
    const purchase = findPurchase(currentUserId, course.id);
    const currentCountry = await resolveCountry(request);
    const pppResult = checkPppAccess(
      course.price,
      course.pppEnabled,
      purchase?.country ?? null,
      currentCountry
    );
    pppBlocked = pppResult.blocked;
    pppBlockedCountry = pppResult.blockedCountry;
    pppPurchaseCountry = pppResult.purchaseCountry;
  }

  // Render lesson content from Markdown to HTML server-side
  const contentHtml = lesson.content
    ? await renderMarkdown(lesson.content)
    : null;

  // Build prev/next navigation
  const allLessons = flattenCourseLessons(courseWithDetails);
  const currentIndex = allLessons.findIndex((l) => l.id === lessonId);
  const prevLesson = currentIndex > 0 ? allLessons[currentIndex - 1] : null;
  const nextLesson =
    currentIndex < allLessons.length - 1 ? allLessons[currentIndex + 1] : null;

  // Check for quiz attached to this lesson
  const quizRecord = getQuizByLessonId(lessonId);
  let quiz: {
    id: number;
    title: string;
    passingScore: number;
    questions: Array<{
      id: number;
      questionText: string;
      questionType: string;
      position: number;
      options: Array<{ id: number; optionText: string }>;
    }>;
  } | null = null;
  let bestAttempt: { score: number; passed: boolean } | null = null;

  if (quizRecord) {
    const quizData = getQuizWithQuestions(quizRecord.id);
    if (quizData) {
      // Strip isCorrect from options so answers aren't leaked to the client
      quiz = {
        id: quizData.id,
        title: quizData.title,
        passingScore: quizData.passingScore,
        questions: quizData.questions.map((q) => ({
          id: q.id,
          questionText: q.questionText,
          questionType: q.questionType,
          position: q.position,
          options: q.options.map((o) => ({
            id: o.id,
            optionText: o.optionText,
          })),
        })),
      };
    }

    if (currentUserId) {
      const best = getBestAttempt(currentUserId, quizRecord.id);
      if (best) {
        bestAttempt = { score: best.score, passed: best.passed };
      }
    }
  }

  // ─── Comments ───
  // Read + write access: enrolled students, plus the course instructor and
  // admins who bypass enrollment. (PPP blocking already short-circuits the
  // lesson UI above, so comments need no extra PPP handling.)
  // Moderation (removing other users' comments) is admin-only — instructors can
  // read/post like any participant but cannot remove others' comments. This can
  // later be extended to a dedicated moderator role.
  const courseInstructorId = course.instructorId;
  const canModerateComments = !!currentUserId && isAdmin;
  const canAccessComments =
    !!currentUserId && (enrolled || isAdmin || isCourseInstructor);

  let comments: {
    threads: CommentView[];
    hasMore: boolean;
    count: number;
    canModerate: boolean;
  } | null = null;

  if (canAccessComments && currentUserId) {
    const viewer: ViewerContext = {
      userId: currentUserId,
      isAdmin,
      canModerate: canModerateComments,
      courseInstructorId,
    };
    const page = await buildCommentViews(lesson.id, viewer, 0);
    comments = {
      threads: page.threads,
      hasMore: page.hasMore,
      count: countTopLevelComments(lesson.id),
      canModerate: canModerateComments,
    };
  }

  return {
    course: {
      id: courseWithDetails.id,
      title: courseWithDetails.title,
      slug: courseWithDetails.slug,
    },
    comments,
    canAccessComments,
    curriculum: courseWithDetails.modules.map((m) => ({
      id: m.id,
      title: m.title,
      lessons: m.lessons.map((l) => ({
        id: l.id,
        title: l.title,
      })),
    })),
    module: {
      id: mod.id,
      title: mod.title,
    },
    lesson,
    contentHtml,
    lessonStatus,
    enrolled,
    currentUserId,
    prevLesson,
    nextLesson,
    quiz,
    bestAttempt,
    lastWatchPosition,
    watchProgress,
    lessonProgressMap,
    bookmarkedLessonIds,
    isBookmarked,
    pppBlocked,
    pppBlockedCountry,
    pppPurchaseCountry,
  };
}

export async function action({ params, request }: Route.ActionArgs) {
  const { slug, lessonId } = parseParams(params, lessonParamsSchema);

  const course = getCourseBySlug(slug);
  if (!course) {
    throw data("Course not found", { status: 404 });
  }

  const currentUserId = await getCurrentUserId(request);
  if (!currentUserId) {
    throw data("You must be logged in", { status: 401 });
  }

  // Lesson access mirrors the loader: enrolled students, plus the course
  // instructor and admins who bypass enrollment. Every intent below acts on
  // gated lesson material (progress, quiz attempts, discussion), so the check
  // is shared. Moderation (removing others' comments) is further restricted to
  // admins within the comment block.
  const currentUser = getUserById(currentUserId);
  const isAdmin = currentUser?.role === UserRole.Admin;
  const isCourseInstructor = course.instructorId === currentUserId;
  const hasLessonAccess =
    isUserEnrolled(currentUserId, course.id) || isAdmin || isCourseInstructor;

  if (!hasLessonAccess) {
    throw data("You don't have access to this lesson.", { status: 403 });
  }

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "mark-complete") {
    // The completion cascade (validation, progress, student-only XP + streak,
    // module-completion toast, enrollment promotion) lives entirely in the
    // service; the route only translates its typed result into HTTP.
    const result = completeLesson({
      userId: currentUserId,
      lessonId,
      courseId: course.id,
    });
    if (!result.ok) {
      return data(
        { error: "Lesson not found in this course." },
        { status: 404 }
      );
    }
    return { success: true, moduleCompletion: result.moduleCompletion };
  }

  if (intent === "toggle-bookmark") {
    // Bookmarking is for enrolled students only. Return (not throw) so a failed
    // toggle surfaces as an inline error instead of replacing the page via the
    // ErrorBoundary.
    if (!isUserEnrolled(currentUserId, course.id)) {
      return data(
        { error: "You must be enrolled to bookmark lessons." },
        { status: 403 }
      );
    }
    // Verify the lesson exists and belongs to this course before writing, so a
    // crafted request can't bookmark a foreign lesson or hit a raw FK 500.
    const lesson = getLessonById(lessonId);
    const mod = lesson ? getModuleById(lesson.moduleId) : null;
    if (!lesson || !mod || mod.courseId !== course.id) {
      return data(
        { error: "Lesson not found in this course." },
        { status: 404 }
      );
    }
    const { bookmarked } = toggleBookmark({ userId: currentUserId, lessonId });
    return { success: true, bookmarked };
  }

  if (intent === "submit-quiz") {
    const quizId = Number(formData.get("quizId"));
    if (isNaN(quizId)) {
      throw data("Invalid quiz ID", { status: 400 });
    }

    // Collect answers: form fields named "question-{questionId}" with value = optionId
    const selectedAnswers: Record<number, number> = {};
    for (const [key, value] of formData.entries()) {
      if (key.startsWith("question-")) {
        const questionId = Number(key.replace("question-", ""));
        const optionId = Number(value);
        if (!isNaN(questionId) && !isNaN(optionId)) {
          selectedAnswers[questionId] = optionId;
        }
      }
    }

    const result = computeResult(currentUserId, quizId, selectedAnswers);
    if (!result) {
      throw data("Failed to score quiz", { status: 500 });
    }

    // Award the first-pass quiz XP, students only (gamification is student-only).
    // The service no-ops on a failing attempt and dedupes repeat passes, so this
    // is safe to call on every submission — only the first *pass* grants 5 XP.
    if (currentUser?.role === UserRole.Student) {
      awardQuizFirstPassXp({
        userId: currentUserId,
        quizId,
        passed: result.passed,
      });
    }

    return { quizResult: result };
  }

  // ─── Comment intents ───
  // Discussion write access is the same lesson access enforced above.
  if (
    intent === "create-comment" ||
    intent === "edit-comment" ||
    intent === "delete-comment" ||
    intent === "load-comments"
  ) {
    // Moderation is admin-only; instructors keep read/write access (and bypass
    // enrollment) but cannot remove other users' comments.
    const canModerateHere = isAdmin;

    if (intent === "create-comment") {
      const parsed = parseFormData(formData, createCommentSchema);
      if (!parsed.success) {
        return data(
          { error: Object.values(parsed.errors)[0] ?? "Invalid comment." },
          { status: 400 }
        );
      }
      try {
        if (parsed.data.parentId !== undefined) {
          const parent = getComment(parsed.data.parentId);
          if (!parent || parent.lessonId !== lessonId) {
            throw data("Parent comment not found.", { status: 404 });
          }
          createReply(parsed.data.parentId, currentUserId, parsed.data.body);
        } else {
          createComment(lessonId, currentUserId, parsed.data.body);
        }
      } catch (error) {
        return data(
          {
            error:
              error instanceof Error
                ? error.message
                : "Failed to post comment.",
          },
          { status: 400 }
        );
      }
      return { success: true };
    }

    if (intent === "edit-comment") {
      const parsed = parseFormData(formData, editCommentSchema);
      if (!parsed.success) {
        return data(
          { error: Object.values(parsed.errors)[0] ?? "Invalid comment." },
          { status: 400 }
        );
      }
      const comment = getComment(parsed.data.commentId);
      if (!comment || comment.lessonId !== lessonId) {
        throw data("Comment not found.", { status: 404 });
      }
      try {
        editComment(comment.id, currentUserId, parsed.data.body);
      } catch (error) {
        return data(
          {
            error:
              error instanceof Error
                ? error.message
                : "Failed to edit comment.",
          },
          { status: 400 }
        );
      }
      return { success: true };
    }

    if (intent === "delete-comment") {
      const parsed = parseFormData(formData, deleteCommentSchema);
      if (!parsed.success) {
        return data(
          { error: Object.values(parsed.errors)[0] ?? "Invalid request." },
          { status: 400 }
        );
      }
      const comment = getComment(parsed.data.commentId);
      if (!comment || comment.lessonId !== lessonId) {
        throw data("Comment not found.", { status: 404 });
      }
      try {
        if (comment.userId === currentUserId) {
          // Author self-delete: no reason, no audit.
          deleteComment(comment.id, currentUserId);
        } else {
          // Moderator removing someone else's comment: audited. The service
          // re-checks moderation rights and throws if unauthorized.
          moderateDeleteComment(
            comment.id,
            currentUserId,
            parsed.data.reason ?? null
          );
        }
      } catch (error) {
        return data(
          {
            error:
              error instanceof Error
                ? error.message
                : "Failed to delete comment.",
          },
          { status: 400 }
        );
      }
      return { success: true };
    }

    // load-comments: pagination read (load-more fetcher).
    const parsed = parseFormData(formData, loadCommentsSchema);
    if (!parsed.success) {
      throw data("Invalid pagination request.", { status: 400 });
    }
    const viewer: ViewerContext = {
      userId: currentUserId,
      isAdmin,
      canModerate: canModerateHere,
      courseInstructorId: course.instructorId,
    };
    const page = await buildCommentViews(lessonId, viewer, parsed.data.offset);
    return { loadedComments: page };
  }

  throw data("Invalid action", { status: 400 });
}

const AUTOPLAY_KEY = "cadence-autoplay";

function useAutoplay() {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    try {
      setEnabled(localStorage.getItem(AUTOPLAY_KEY) === "true");
    } catch {
      /* silently fail */
    }
  }, []);

  const toggle = useCallback(() => {
    setEnabled((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(AUTOPLAY_KEY, String(next));
      } catch {
        /* silently fail */
      }
      return next;
    });
  }, []);

  return [enabled, toggle] as const;
}

export default function LessonViewer({ loaderData }: Route.ComponentProps) {
  const {
    course,
    curriculum,
    module: mod,
    lesson,
    contentHtml,
    comments,
    lessonStatus,
    enrolled,
    currentUserId,
    prevLesson,
    nextLesson,
    quiz,
    bestAttempt,
    lastWatchPosition,
    watchProgress,
    lessonProgressMap,
    bookmarkedLessonIds,
    isBookmarked,
    pppBlocked,
    pppBlockedCountry,
    pppPurchaseCountry,
  } = loaderData;
  const [autoplay, toggleAutoplay] = useAutoplay();
  const fetcher = useFetcher({ key: `mark-complete-${lesson.id}` });
  const quizFetcher = useFetcher({ key: `quiz-${lesson.id}` });
  const bookmarkFetcher = useFetcher({ key: `bookmark-${lesson.id}` });
  const navigate = useNavigate();

  // Optimistic bookmark state: reflect the in-flight toggle immediately, then
  // fall back to the loader value once revalidation settles.
  const bookmarked =
    bookmarkFetcher.formData?.get("intent") === "toggle-bookmark"
      ? !isBookmarked
      : (bookmarkFetcher.data?.bookmarked ?? isBookmarked);

  // If the toggle fails, the optimistic icon reverts on revalidation — surface
  // the reason so the snap-back isn't silent.
  useEffect(() => {
    if (bookmarkFetcher.state === "idle" && bookmarkFetcher.data?.error) {
      toast.error(bookmarkFetcher.data.error);
    }
  }, [bookmarkFetcher.state, bookmarkFetcher.data]);

  const isMarking =
    fetcher.state !== "idle" &&
    fetcher.formData?.get("intent") === "mark-complete";

  const justCompleted = fetcher.data?.success;

  const isCompleted =
    lessonStatus === LessonProgressStatus.Completed || justCompleted;

  // Celebrate finishing a module with a single toast showing its total XP. Fires
  // only when the completed lesson was the module's last — non-final lessons and
  // re-completions return no payload from the action. Sonner lives in the app
  // layout, so the toast survives the navigation to the next lesson below.
  const moduleCompletion = fetcher.data?.moduleCompletion;
  useEffect(() => {
    if (moduleCompletion) {
      toast.success(`Module complete! +${moduleCompletion.xpEarned} XP earned`);
    }
  }, [moduleCompletion]);

  // Navigate to next lesson after marking complete
  useEffect(() => {
    if (justCompleted && nextLesson) {
      navigate(`/courses/${course.slug}/lessons/${nextLesson.id}`);
    }
  }, [justCompleted, nextLesson, course.slug, navigate]);

  const quizResult = quizFetcher.data?.quizResult ?? null;
  const isSubmittingQuiz = quizFetcher.state !== "idle";

  if (pppBlocked) {
    const purchaseCountryName = pppPurchaseCountry
      ? (COUNTRIES.find((c) => c.code === pppPurchaseCountry)?.name ??
        pppPurchaseCountry)
      : "your original country";
    const currentCountryName = pppBlockedCountry
      ? (COUNTRIES.find((c) => c.code === pppBlockedCountry)?.name ??
        pppBlockedCountry)
      : "a different country";

    return (
      <div className="flex min-h-[60vh] items-center justify-center p-6">
        <div className="max-w-md text-center">
          <ShieldAlert className="mx-auto mb-4 size-16 text-amber-500" />
          <h1 className="mb-3 text-2xl font-bold">Access Restricted</h1>
          <p className="mb-4 text-muted-foreground">
            You purchased this course with a Purchasing Power Parity discount
            while in <strong>{purchaseCountryName}</strong>, but you're
            currently accessing from <strong>{currentCountryName}</strong>.
          </p>
          <p className="mb-6 text-sm text-muted-foreground">
            PPP-discounted courses can only be accessed from the country where
            the purchase was made. This helps keep courses affordable for
            students in lower-income regions.
          </p>
          <div className="flex items-center justify-center gap-3">
            <Link to={`/courses/${course.slug}`}>
              <Button variant="outline">
                <MapPin className="mr-2 size-4" />
                Back to Course
              </Button>
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex">
      {/* Curriculum Sidebar */}
      <CurriculumSidebar
        course={course}
        curriculum={curriculum}
        currentLessonId={lesson.id}
        lessonProgressMap={lessonProgressMap}
        bookmarkedLessonIds={bookmarkedLessonIds}
        enrolled={enrolled}
      />

      <div className="flex-1 p-6 lg:p-8">
        {/* Breadcrumb */}
        <nav className="mb-6 text-sm text-muted-foreground">
          <Link to="/courses" className="hover:text-foreground">
            Courses
          </Link>
          <span className="mx-2">/</span>
          <Link
            to={`/courses/${course.slug}`}
            className="hover:text-foreground"
          >
            {course.title}
          </Link>
          <span className="mx-2">/</span>
          <Link
            to={`/courses/${course.slug}/${mod.id}`}
            className="hover:text-foreground"
          >
            {mod.title}
          </Link>
          <span className="mx-2">/</span>
          <span className="text-foreground">{lesson.title}</span>
        </nav>

        <div className="mx-auto max-w-4xl">
          {/* Lesson Title */}
          <h1 className="mb-2 text-3xl font-bold">{lesson.title}</h1>
          <div className="mb-6 flex items-center gap-3">
            {lesson.durationMinutes && (
              <div className="flex items-center gap-1 text-sm text-muted-foreground">
                <Clock className="size-4" />
                {formatDuration(lesson.durationMinutes, true, false, false)}
              </div>
            )}
            {lesson.githubRepoUrl && (
              <a
                href={lesson.githubRepoUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Button variant="outline" size="sm">
                  <Github className="mr-1.5 size-4" />
                  Open Code
                </Button>
              </a>
            )}
            {enrolled && currentUserId && (
              <bookmarkFetcher.Form method="post">
                <input type="hidden" name="intent" value="toggle-bookmark" />
                <Button
                  type="submit"
                  variant="outline"
                  size="sm"
                  aria-pressed={bookmarked}
                >
                  <Bookmark
                    className={cn(
                      "mr-1.5 size-4",
                      bookmarked
                        ? "fill-amber-500 text-amber-500"
                        : "text-muted-foreground"
                    )}
                  />
                  {bookmarked ? "Bookmarked" : "Bookmark"}
                </Button>
              </bookmarkFetcher.Form>
            )}
          </div>

          {/* YouTube Video */}
          {lesson.videoUrl && (
            <YouTubePlayer
              videoUrl={lesson.videoUrl}
              lessonId={lesson.id}
              title={lesson.title}
              startPosition={lastWatchPosition}
              durationMinutes={lesson.durationMinutes}
              watchProgress={watchProgress}
              trackingEnabled={enrolled && !!currentUserId}
              autoplay={autoplay}
              onToggleAutoplay={toggleAutoplay}
            />
          )}

          {/* Lesson Content */}
          {contentHtml && (
            <div
              className="prose prose-neutral dark:prose-invert mb-8 max-w-none"
              dangerouslySetInnerHTML={{ __html: contentHtml }}
            />
          )}

          {!contentHtml && !lesson.videoUrl && (
            <Card className="mb-8">
              <CardContent className="py-12 text-center text-muted-foreground">
                No content has been added to this lesson yet.
              </CardContent>
            </Card>
          )}

          {/* Quiz Section */}
          {quiz && enrolled && currentUserId && (
            <QuizSection
              quiz={quiz}
              bestAttempt={bestAttempt}
              quizResult={quizResult}
              quizFetcher={quizFetcher}
              isSubmitting={isSubmittingQuiz}
            />
          )}

          {/* Mark Complete / Up Next */}
          {enrolled && currentUserId && (
            <div className="mb-8">
              {isCompleted ? (
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2 text-green-600">
                    <CheckCircle2 className="size-5" />
                    <span className="font-medium">Lesson completed</span>
                  </div>
                  {nextLesson && (
                    <Link
                      to={`/courses/${course.slug}/lessons/${nextLesson.id}`}
                    >
                      <Button variant="outline" size="sm">
                        Up next: {nextLesson.title}
                        <ChevronRight className="ml-1 size-4" />
                      </Button>
                    </Link>
                  )}
                </div>
              ) : nextLesson ? (
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="mark-complete" />
                  <Button disabled={isMarking}>
                    {isMarking ? (
                      "Completing..."
                    ) : (
                      <>
                        Up next: {nextLesson.title}
                        <ChevronRight className="ml-1 size-4" />
                      </>
                    )}
                  </Button>
                </fetcher.Form>
              ) : (
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="mark-complete" />
                  <Button disabled={isMarking}>
                    <CheckCircle2 className="mr-2 size-4" />
                    {isMarking ? "Marking..." : "Mark as Complete"}
                  </Button>
                </fetcher.Form>
              )}
            </div>
          )}

          {/* Discussion */}
          {comments && currentUserId && (
            <DiscussionSection
              comments={comments}
              lessonId={lesson.id}
              currentUserId={currentUserId}
            />
          )}

          {/* Prev/Next Navigation */}
          <div className="flex items-center justify-between border-t pt-6">
            {prevLesson ? (
              <Link
                to={`/courses/${course.slug}/lessons/${prevLesson.id}`}
                className="flex items-center gap-2 text-sm hover:text-foreground text-muted-foreground"
              >
                <ChevronLeft className="size-4" />
                <div>
                  <div className="text-xs text-muted-foreground">Previous</div>
                  <div className="font-medium text-foreground">
                    {prevLesson.title}
                  </div>
                </div>
              </Link>
            ) : (
              <div />
            )}

            {nextLesson ? (
              <Link
                to={`/courses/${course.slug}/lessons/${nextLesson.id}`}
                className="flex items-center gap-2 text-right text-sm hover:text-foreground text-muted-foreground"
              >
                <div>
                  <div className="text-xs text-muted-foreground">Next</div>
                  <div className="font-medium text-foreground">
                    {nextLesson.title}
                  </div>
                </div>
                <ChevronRight className="size-4" />
              </Link>
            ) : (
              <Link
                to={`/courses/${course.slug}`}
                className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
              >
                <div>
                  <div className="text-xs text-muted-foreground">Back to</div>
                  <div className="font-medium text-foreground">
                    {course.title}
                  </div>
                </div>
                <ChevronRight className="size-4" />
              </Link>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function CurriculumSidebar({
  course,
  curriculum,
  currentLessonId,
  lessonProgressMap,
  bookmarkedLessonIds,
  enrolled,
}: {
  course: { id: number; title: string; slug: string };
  curriculum: Array<{
    id: number;
    title: string;
    lessons: Array<{ id: number; title: string }>;
  }>;
  currentLessonId: number;
  lessonProgressMap: Record<number, string>;
  bookmarkedLessonIds: number[];
  enrolled: boolean;
}) {
  const bookmarkedSet = new Set(bookmarkedLessonIds);
  // Find which module the current lesson belongs to
  const currentModuleId = curriculum.find((m) =>
    m.lessons.some((l) => l.id === currentLessonId)
  )?.id;

  const [expandedModules, setExpandedModules] = useState<Set<number>>(() => {
    // Start with current module expanded
    const initial = new Set<number>();
    if (currentModuleId) initial.add(currentModuleId);
    return initial;
  });

  function toggleModule(moduleId: number) {
    setExpandedModules((prev) => {
      const next = new Set(prev);
      if (next.has(moduleId)) {
        next.delete(moduleId);
      } else {
        next.add(moduleId);
      }
      return next;
    });
  }

  return (
    <aside className="hidden w-72 shrink-0 border-r border-border lg:block">
      <div className="sticky top-0 flex h-screen flex-col overflow-y-auto">
        <div className="border-b border-border p-4">
          <Link
            to={`/courses/${course.slug}`}
            className="text-sm font-semibold hover:text-primary"
          >
            {course.title}
          </Link>
        </div>

        <nav className="flex-1 p-2">
          {curriculum.map((mod) => {
            const isExpanded = expandedModules.has(mod.id);
            const moduleHasBookmark = mod.lessons.some((l) =>
              bookmarkedSet.has(l.id)
            );

            return (
              <div key={mod.id} className="mb-1">
                <button
                  onClick={() => toggleModule(mod.id)}
                  className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-foreground/80 hover:bg-muted"
                >
                  <ChevronDown
                    className={cn(
                      "size-4 shrink-0 transition-transform",
                      !isExpanded && "-rotate-90"
                    )}
                  />
                  <span className="flex-1 text-left">{mod.title}</span>
                  {moduleHasBookmark && (
                    <Bookmark className="size-3.5 shrink-0 fill-amber-500 text-amber-500" />
                  )}
                </button>

                {isExpanded && (
                  <ul className="ml-4 space-y-0.5 py-1">
                    {mod.lessons.map((l) => {
                      const isCurrent = l.id === currentLessonId;
                      const status = lessonProgressMap[l.id];
                      const isCompleted =
                        status === LessonProgressStatus.Completed;
                      const isInProgress =
                        status === LessonProgressStatus.InProgress;
                      const isBookmarked = bookmarkedSet.has(l.id);

                      return (
                        <li key={l.id}>
                          <Link
                            to={`/courses/${course.slug}/lessons/${l.id}`}
                            className={cn(
                              "flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors",
                              isCurrent
                                ? "bg-primary/10 font-medium text-primary"
                                : "text-muted-foreground hover:bg-muted hover:text-foreground"
                            )}
                          >
                            {enrolled ? (
                              isCompleted ? (
                                <CheckCircle2 className="size-3.5 shrink-0 text-green-500" />
                              ) : isInProgress ? (
                                <PlayCircle className="size-3.5 shrink-0 text-blue-500" />
                              ) : (
                                <Circle className="size-3.5 shrink-0" />
                              )
                            ) : (
                              <Circle className="size-3.5 shrink-0" />
                            )}
                            <span className="flex-1 truncate">{l.title}</span>
                            {isBookmarked && (
                              <Bookmark className="size-3.5 shrink-0 fill-amber-500 text-amber-500" />
                            )}
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })}
        </nav>
      </div>
    </aside>
  );
}

function QuizSection({
  quiz,
  bestAttempt,
  quizResult,
  quizFetcher,
  isSubmitting,
}: {
  quiz: {
    id: number;
    title: string;
    passingScore: number;
    questions: Array<{
      id: number;
      questionText: string;
      questionType: string;
      position: number;
      options: Array<{ id: number; optionText: string }>;
    }>;
  };
  bestAttempt: { score: number; passed: boolean } | null;
  quizResult: {
    attemptId: number;
    score: number;
    passed: boolean;
    grade: string;
    totalCorrect: number;
    totalQuestions: number;
    questionResults: Array<{
      questionId: number;
      correct: boolean;
      selectedOptionId: number | null;
      correctOptionId: number | null;
    }>;
  } | null;
  quizFetcher: ReturnType<typeof useFetcher>;
  isSubmitting: boolean;
}) {
  const [selectedAnswers, setSelectedAnswers] = useState<
    Record<number, number>
  >({});
  const [showQuiz, setShowQuiz] = useState(!bestAttempt?.passed);
  const [retaking, setRetaking] = useState(false);

  useEffect(() => {
    if (quizResult && !retaking) {
      if (quizResult.passed) {
        toast.success(
          `Quiz passed! Score: ${Math.round(quizResult.score * 100)}%`
        );
      } else {
        toast.error(
          `Quiz not passed. Score: ${Math.round(quizResult.score * 100)}%`
        );
      }
    }
  }, [quizResult, retaking]);

  const allAnswered = quiz.questions.every(
    (q) => selectedAnswers[q.id] !== undefined
  );
  const showResult = quizResult && !retaking;

  if (showResult) {
    return (
      <Card className="mb-8">
        <CardContent className="p-6">
          <div className="mb-4 flex items-center gap-2">
            <HelpCircle className="size-5 text-primary" />
            <h2 className="text-xl font-semibold">{quiz.title}</h2>
          </div>

          {/* Results summary */}
          <div
            className={`mb-6 rounded-lg p-4 ${quizResult.passed ? "bg-green-50 dark:bg-green-950" : "bg-red-50 dark:bg-red-950"}`}
          >
            <div className="flex items-center gap-3">
              {quizResult.passed ? (
                <Trophy className="size-8 text-green-600" />
              ) : (
                <XCircle className="size-8 text-red-600" />
              )}
              <div>
                <p
                  className={`text-lg font-semibold ${quizResult.passed ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}`}
                >
                  {quizResult.passed ? "You passed!" : "Not quite — try again!"}
                </p>
                <p className="text-sm text-muted-foreground">
                  Score: {quizResult.totalCorrect}/{quizResult.totalQuestions} (
                  {Math.round(quizResult.score * 100)}%) — Grade:{" "}
                  {quizResult.grade}
                </p>
              </div>
            </div>
          </div>

          {/* Per-question results */}
          <div className="space-y-4">
            {quiz.questions.map((question, qIndex) => {
              const result = quizResult.questionResults.find(
                (r) => r.questionId === question.id
              );
              return (
                <div key={question.id} className="rounded-lg border p-4">
                  <div className="mb-2 flex items-start gap-2">
                    {result?.correct ? (
                      <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-green-600" />
                    ) : (
                      <XCircle className="mt-0.5 size-5 shrink-0 text-red-600" />
                    )}
                    <p className="font-medium">
                      {qIndex + 1}. {question.questionText}
                    </p>
                  </div>
                  <div className="ml-7 space-y-1">
                    {question.options.map((option) => {
                      const isSelected = result?.selectedOptionId === option.id;
                      const isCorrect = result?.correctOptionId === option.id;
                      let className = "text-sm";
                      if (isCorrect)
                        className +=
                          " font-medium text-green-700 dark:text-green-400";
                      else if (isSelected && !result?.correct)
                        className +=
                          " text-red-600 dark:text-red-400 line-through";
                      return (
                        <p key={option.id} className={className}>
                          {isCorrect ? "✓ " : isSelected ? "✗ " : "  "}
                          {option.optionText}
                        </p>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Retake button */}
          {!quizResult.passed && (
            <div className="mt-6">
              <Button
                variant="outline"
                onClick={() => {
                  setSelectedAnswers({});
                  setRetaking(true);
                }}
              >
                <RotateCcw className="mr-2 size-4" />
                Retake Quiz
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  if (!showQuiz && bestAttempt?.passed) {
    return (
      <Card className="mb-8">
        <CardContent className="p-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Trophy className="size-5 text-green-600" />
              <span className="font-medium">{quiz.title}</span>
              <span className="text-sm text-muted-foreground">
                — Best score: {Math.round(bestAttempt.score * 100)}%
              </span>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowQuiz(true)}
            >
              <RotateCcw className="mr-2 size-4" />
              Retake
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="mb-8">
      <CardContent className="p-6">
        <div className="mb-4 flex items-center gap-2">
          <HelpCircle className="size-5 text-primary" />
          <h2 className="text-xl font-semibold">{quiz.title}</h2>
        </div>
        <p className="mb-6 text-sm text-muted-foreground">
          Answer all questions and submit. Passing score:{" "}
          {Math.round(quiz.passingScore * 100)}%.
        </p>

        <quizFetcher.Form method="post" onSubmit={() => setRetaking(false)}>
          <input type="hidden" name="intent" value="submit-quiz" />
          <input type="hidden" name="quizId" value={quiz.id} />

          <div className="space-y-6">
            {quiz.questions.map((question, qIndex) => (
              <div key={question.id} className="rounded-lg border p-4">
                <p className="mb-3 font-medium">
                  {qIndex + 1}. {question.questionText}
                </p>
                <div className="space-y-2">
                  {question.options.map((option) => (
                    <label
                      key={option.id}
                      className="flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 hover:bg-muted"
                    >
                      <input
                        type="radio"
                        name={`question-${question.id}`}
                        value={option.id}
                        checked={selectedAnswers[question.id] === option.id}
                        onChange={() =>
                          setSelectedAnswers((prev) => ({
                            ...prev,
                            [question.id]: option.id,
                          }))
                        }
                        className="size-4 accent-primary"
                      />
                      <span className="text-sm">{option.optionText}</span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-6">
            <Button type="submit" disabled={!allAnswered || isSubmitting}>
              {isSubmitting ? "Submitting..." : "Submit Quiz"}
            </Button>
            {!allAnswered && (
              <p className="mt-2 text-sm text-muted-foreground">
                Please answer all questions before submitting.
              </p>
            )}
          </div>
        </quizFetcher.Form>
      </CardContent>
    </Card>
  );
}

function formatCommentDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function AuthorBadges({ comment }: { comment: CommentView }) {
  return (
    <>
      {comment.authorIsCourseInstructor && (
        <span className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-medium text-blue-800 dark:bg-blue-900/30 dark:text-blue-400">
          Instructor
        </span>
      )}
      {comment.authorIsAdmin && (
        <span className="inline-flex items-center rounded-full bg-purple-100 px-2 py-0.5 text-[11px] font-medium text-purple-800 dark:bg-purple-900/30 dark:text-purple-400">
          Admin
        </span>
      )}
    </>
  );
}

function CommentComposer({
  lessonId,
  parentId,
  onDone,
  autoFocus,
  placeholder,
}: {
  lessonId: number;
  parentId?: number;
  onDone?: () => void;
  autoFocus?: boolean;
  placeholder?: string;
}) {
  const fetcher = useFetcher();
  const [body, setBody] = useState("");
  const isSubmitting = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.success) {
      setBody("");
      onDone?.();
    }
    if (fetcher.state === "idle" && fetcher.data?.error) {
      toast.error(fetcher.data.error);
    }
    // onDone intentionally omitted to avoid re-running on parent re-renders
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  return (
    <fetcher.Form method="post">
      <input type="hidden" name="intent" value="create-comment" />
      {parentId !== undefined && (
        <input type="hidden" name="parentId" value={parentId} />
      )}
      <Textarea
        name="body"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={
          placeholder ??
          "Ask a question or share your thoughts… (Markdown supported)"
        }
        rows={parentId ? 2 : 3}
        maxLength={5000}
        autoFocus={autoFocus}
        required
      />
      <div className="mt-2 flex items-center gap-2">
        <Button
          type="submit"
          size="sm"
          disabled={isSubmitting || body.trim().length === 0}
        >
          {isSubmitting ? "Posting…" : parentId ? "Reply" : "Post comment"}
        </Button>
        {onDone && (
          <Button type="button" variant="ghost" size="sm" onClick={onDone}>
            Cancel
          </Button>
        )}
      </div>
    </fetcher.Form>
  );
}

function CommentItem({
  comment,
  lessonId,
  currentUserId,
  canModerate,
  isReply,
}: {
  comment: CommentView;
  lessonId: number;
  currentUserId: number;
  canModerate: boolean;
  isReply: boolean;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [isReplying, setIsReplying] = useState(false);
  const editFetcher = useFetcher();
  const deleteFetcher = useFetcher();

  useEffect(() => {
    if (editFetcher.state === "idle" && editFetcher.data?.success) {
      setIsEditing(false);
    }
    if (editFetcher.state === "idle" && editFetcher.data?.error) {
      toast.error(editFetcher.data.error);
    }
  }, [editFetcher.state, editFetcher.data]);

  useEffect(() => {
    if (deleteFetcher.state === "idle" && deleteFetcher.data?.error) {
      toast.error(deleteFetcher.data.error);
    }
  }, [deleteFetcher.state, deleteFetcher.data]);

  function handleDelete() {
    const isOwn = comment.authorId === currentUserId;
    if (isOwn) {
      if (!window.confirm("Delete this comment?")) return;
      deleteFetcher.submit(
        { intent: "delete-comment", commentId: String(comment.id) },
        { method: "post" }
      );
    } else {
      // Moderator removing another user's comment — capture an optional reason.
      const reason = window.prompt(
        "Reason for removing this comment (optional). Press Cancel to abort."
      );
      if (reason === null) return; // cancelled
      deleteFetcher.submit(
        {
          intent: "delete-comment",
          commentId: String(comment.id),
          reason,
        },
        { method: "post" }
      );
    }
  }

  const canReply = !isReply && !comment.isDeleted;

  return (
    <div className="flex gap-3">
      <UserAvatar
        name={comment.authorName}
        avatarUrl={comment.authorAvatarUrl}
        className="size-8 shrink-0"
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-semibold">{comment.authorName}</span>
          <AuthorBadges comment={comment} />
          <span className="text-xs text-muted-foreground">
            {formatCommentDate(comment.createdAt)}
          </span>
          {comment.edited && (
            <span className="text-xs text-muted-foreground">(edited)</span>
          )}
        </div>

        {isEditing ? (
          <editFetcher.Form method="post" className="mt-2">
            <input type="hidden" name="intent" value="edit-comment" />
            <input type="hidden" name="commentId" value={comment.id} />
            <Textarea
              name="body"
              defaultValue={comment.rawBody ?? ""}
              rows={3}
              maxLength={5000}
              autoFocus
              required
            />
            <div className="mt-2 flex items-center gap-2">
              <Button
                type="submit"
                size="sm"
                disabled={editFetcher.state !== "idle"}
              >
                {editFetcher.state !== "idle" ? "Saving…" : "Save"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setIsEditing(false)}
              >
                Cancel
              </Button>
            </div>
          </editFetcher.Form>
        ) : comment.isDeleted ? (
          <div className="mt-1">
            <p className="text-sm italic text-muted-foreground">[deleted]</p>
            {comment.removalReason && (
              <p className="mt-1 text-xs text-muted-foreground">
                Removed by a moderator: {comment.removalReason}
              </p>
            )}
          </div>
        ) : (
          <div
            className="prose prose-sm prose-neutral mt-1 max-w-none dark:prose-invert"
            dangerouslySetInnerHTML={{ __html: comment.bodyHtml ?? "" }}
          />
        )}

        {/* Action row */}
        {!isEditing && (
          <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
            {canReply && (
              <button
                type="button"
                onClick={() => setIsReplying((v) => !v)}
                className="inline-flex items-center gap-1 hover:text-foreground"
              >
                <Reply className="size-3.5" />
                Reply
              </button>
            )}
            {comment.canEdit && (
              <button
                type="button"
                onClick={() => setIsEditing(true)}
                className="inline-flex items-center gap-1 hover:text-foreground"
              >
                <Pencil className="size-3.5" />
                Edit
              </button>
            )}
            {(comment.canDelete || comment.canModerate) && (
              <button
                type="button"
                onClick={handleDelete}
                disabled={deleteFetcher.state !== "idle"}
                className="inline-flex items-center gap-1 hover:text-destructive"
              >
                <Trash2 className="size-3.5" />
                {comment.canDelete ? "Delete" : "Remove"}
              </button>
            )}
          </div>
        )}

        {/* Reply composer */}
        {isReplying && (
          <div className="mt-3">
            <CommentComposer
              lessonId={lessonId}
              parentId={comment.id}
              autoFocus
              placeholder="Write a reply… (Markdown supported)"
              onDone={() => setIsReplying(false)}
            />
          </div>
        )}

        {/* Replies (one level deep) */}
        {comment.replies.length > 0 && (
          <ul className="mt-4 space-y-4 border-l border-border pl-4">
            {comment.replies.map((reply) => (
              <li key={reply.id}>
                <CommentItem
                  comment={reply}
                  lessonId={lessonId}
                  currentUserId={currentUserId}
                  canModerate={canModerate}
                  isReply
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function DiscussionSection({
  comments,
  lessonId,
  currentUserId,
}: {
  comments: {
    threads: CommentView[];
    hasMore: boolean;
    count: number;
    canModerate: boolean;
  };
  lessonId: number;
  currentUserId: number;
}) {
  const initialThreads = comments.threads;
  const [threads, setThreads] = useState(initialThreads);
  const [hasMore, setHasMore] = useState(comments.hasMore);
  const loadFetcher = useFetcher();

  // Reset to the freshly-loaded first page whenever the loader revalidates
  // (after posting / editing / deleting). Any extra pages from "load more"
  // collapse back to the first page, which the user can re-expand.
  useEffect(() => {
    setThreads(initialThreads);
    setHasMore(comments.hasMore);
  }, [initialThreads, comments.hasMore]);

  // Append pages fetched via the load-more fetcher.
  useEffect(() => {
    const loaded = loadFetcher.data?.loadedComments;
    if (loaded) {
      setThreads((prev) => {
        const seen = new Set(prev.map((t) => t.id));
        return [
          ...prev,
          ...loaded.threads.filter((t: CommentView) => !seen.has(t.id)),
        ];
      });
      setHasMore(loaded.hasMore);
    }
  }, [loadFetcher.data]);

  function loadMore() {
    loadFetcher.submit(
      { intent: "load-comments", offset: String(threads.length) },
      { method: "post" }
    );
  }

  return (
    <section className="mt-12 border-t pt-8">
      <h2 className="mb-6 flex items-center gap-2 text-2xl font-bold">
        <MessageSquare className="size-6" />
        Discussion ({comments.count})
      </h2>

      <CommentComposer lessonId={lessonId} />

      {threads.length === 0 ? (
        <p className="py-8 text-center text-muted-foreground">
          No comments yet. Start the discussion!
        </p>
      ) : (
        <ul className="mt-8 space-y-6">
          {threads.map((thread) => (
            <li key={thread.id}>
              <CommentItem
                comment={thread}
                lessonId={lessonId}
                currentUserId={currentUserId}
                canModerate={comments.canModerate}
                isReply={false}
              />
            </li>
          ))}
        </ul>
      )}

      {hasMore && (
        <div className="mt-6 flex justify-center">
          <Button
            variant="outline"
            onClick={loadMore}
            disabled={loadFetcher.state !== "idle"}
          >
            {loadFetcher.state !== "idle" ? "Loading…" : "Load more comments"}
          </Button>
        </div>
      )}
    </section>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading this lesson.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 404) {
      title = "Lesson not found";
      message =
        "The lesson you're looking for doesn't exist or may have been removed.";
    } else if (error.status === 401) {
      title = "Sign in required";
      message =
        typeof error.data === "string"
          ? error.data
          : "Please select a user from the DevUI panel.";
    } else {
      title = `Error ${error.status}`;
      message = typeof error.data === "string" ? error.data : error.statusText;
    }
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <div className="flex items-center justify-center gap-3">
          <Link to="/courses">
            <Button variant="outline">Browse Courses</Button>
          </Link>
          <Link to="/dashboard">
            <Button>My Dashboard</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
