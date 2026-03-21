export interface HomeworkDocumentSection {
  sectionNumber: number;
  fullName: string;
  pageStart: number;
  pageEnd: number;
  pdfPageStart: number;
  pdfPageEnd: number;
}

export interface HomeworkSectionCacheEntry {
  sectionNumber: number;
  cacheFile: string;
  cachedAt: string;
  charCount: number;
  version?: number;
  strategy?: string;
}

export interface HomeworkDocumentMetadata {
  id: string;
  title: string;
  originalFilename: string;
  sectionType: string;
  tocPagePdf: number;
  tocPageLogical: number;
  pageOffset: number;
  pageCount: number;
  createdAt: string;
  updatedAt: string;
  model: string;
  sections: HomeworkDocumentSection[];
  cachedSections: Record<string, HomeworkSectionCacheEntry>;
}

export interface HomeworkDocumentSummary {
  id: string;
  title: string;
  originalFilename: string;
  sectionType: string;
  tocPagePdf: number;
  tocPageLogical: number;
  pageOffset: number;
  pageCount: number;
  createdAt: string;
  updatedAt: string;
  sectionCount: number;
  cachedSectionCount: number;
  sections: HomeworkDocumentSection[];
}

export interface CreateHomeworkDocumentInput {
  title?: string;
  originalFilename: string;
  pdfBuffer: Buffer;
  tocPagePdf: number;
  pageOffset: number;
  sectionType: string;
}
