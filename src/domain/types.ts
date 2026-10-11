export interface Sense {
  id: string;
  word: string;
  partOfSpeech: string;
  meaning: string;
  sourceLine: number;
  sourceText: string;
  origin: 'import' | 'lookup';
}

export interface ImportIssue {
  line: number;
  text: string;
  message: string;
}

export interface ParsedVocabulary {
  senses: Sense[];
  issues: ImportIssue[];
  duplicateCount: number;
}

export interface ArticleOccurrence {
  senseId: string;
  start: number;
  end: number;
  surface: string;
}

export interface Article {
  id: string;
  title: string;
  body: string;
  theme: string;
  targetSenseIds: string[];
  occurrences: ArticleOccurrence[];
  wordCount: number;
  targetWordCount: number;
  createdAt: string;
  phase?: 'coverage' | 'review';
  reviewRound?: number;
  roundTotal?: number;
  roundCovered?: number;
  unknownSenseIds?: string[];
  finishedAt?: string;
  verificationWarnings?: string[];
}

export interface LearningSession {
  id: string;
  phase: 'coverage' | 'review' | 'complete';
  remainingSenseIds: string[];
  coveredSenseIds: string[];
  accumulatedUnknownIds: string[];
  reviewSenseIds: string[];
  reviewPendingIds: string[];
  reviewUnknownIds: string[];
  reviewRound: number;
  currentUnknownIds: string[];
  articles: Article[];
  currentArticleId: string | null;
  preparedArticle?: Article | null;
}

export interface ReadingOptions {
  targetCount: number;
  expectedWordCount: number;
}

export interface VocabularyScreening {
  unknownSenseIds: string[];
  updatedAt: string;
}

export interface LibraryBranch {
  parentLibraryId: string;
  parentLibraryName: string;
  createdAt: string;
}

export interface Workspace {
  version: 1;
  id?: string;
  name: string;
  sourceText: string;
  senses: Sense[];
  session: LearningSession | null;
  updatedAt: string;
  readingOptions?: ReadingOptions;
  archivedSessions?: LearningSession[];
  screening?: VocabularyScreening;
  branch?: LibraryBranch;
}

export interface LibraryCollection {
  version: 1;
  libraries: Workspace[];
  activeLibraryId: string | null;
}

export interface ApiSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  configured?: boolean;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type ProgressReporter = (message: string) => void;

export interface RefinementEntry {
  sourceId: string;
  senses: Sense[];
  issue?: string;
}

export interface RefinementCheckpoint {
  sources: Sense[];
  entries: RefinementEntry[];
}

export interface ImportDraft {
  version: 1;
  name: string;
  sourceText: string;
  encoding: 'auto' | 'utf-8' | 'gb18030';
  preview: ParsedVocabulary;
  checkpoint: RefinementCheckpoint | null;
  reviewSenseIds: string[];
  refined: boolean;
}
