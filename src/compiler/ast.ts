export type KuratchiFileKind = 'route' | 'layout' | 'component';

export interface KuratchiSourceSpan {
  start: number;
  end: number;
}

export interface KuratchiScriptAst {
  kind: 'script';
  attrs: string;
  content: string;
  openTag: string;
  span: KuratchiSourceSpan;
  contentSpan: KuratchiSourceSpan;
}

export interface KuratchiTemplateAst {
  kind: 'template';
  source: string;
  span: KuratchiSourceSpan;
  nodes: KuratchiTemplateNode[];
}

export interface KuratchiFileAst {
  kind: KuratchiFileKind;
  filePath?: string;
  source: string;
  script: KuratchiScriptAst | null;
  template: KuratchiTemplateAst;
}

export type KuratchiTemplateNode =
  | KuratchiTemplateTextAst
  | KuratchiTemplateCommentAst
  | KuratchiTemplateTagAst
  | KuratchiTemplateExpressionAst
  | KuratchiTemplateRawBlockAst;

export interface KuratchiTemplateTextAst {
  kind: 'text';
  value: string;
  span: KuratchiSourceSpan;
}

export interface KuratchiTemplateCommentAst {
  kind: 'comment';
  value: string;
  span: KuratchiSourceSpan;
}

export interface KuratchiTemplateTagAst {
  kind: 'tag';
  name: string;
  attrs: KuratchiTemplateAttributeAst[];
  closing: boolean;
  selfClosing: boolean;
  raw: string;
  span: KuratchiSourceSpan;
}

export interface KuratchiTemplateAttributeAst {
  name: string;
  value: string | null;
  raw: string;
  span: KuratchiSourceSpan;
}

export interface KuratchiTemplateExpressionAst {
  kind: 'expression';
  expression: string;
  raw: string;
  span: KuratchiSourceSpan;
}

export interface KuratchiTemplateRawBlockAst {
  kind: 'raw-block';
  name: 'script' | 'style';
  attrs: KuratchiTemplateAttributeAst[];
  content: string;
  raw: string;
  span: KuratchiSourceSpan;
  contentSpan: KuratchiSourceSpan;
}
