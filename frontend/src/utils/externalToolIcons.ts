import {
  BookOpen,
  Box,
  ExternalLink,
  Github,
  Globe,
  Headphones,
  LayoutGrid,
  Link2,
  MessageSquare,
  Search,
  Server,
  Shield,
  Ticket,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

/** Shared Lucide map for waffle menu + Admin icon picker. */
export const EXTERNAL_TOOL_ICONS: Record<string, LucideIcon> = {
  link: Link2,
  globe: Globe,
  global: Globe,
  earth: Globe,
  ticket: Ticket,
  jira: Ticket,
  headset: Headphones,
  headphones: Headphones,
  servicenow: Headphones,
  github: Github,
  git: Github,
  book: BookOpen,
  wiki: BookOpen,
  confluence: BookOpen,
  search: Search,
  sonar: Search,
  sonarqube: Search,
  box: Box,
  artifactory: Box,
  server: Server,
  polarion: Server,
  shield: Shield,
  wrench: Wrench,
  tools: Wrench,
  chat: MessageSquare,
  gpt: MessageSquare,
  grid: LayoutGrid,
};

export function resolveExternalToolIcon(name?: string): LucideIcon {
  if (!name) return ExternalLink;
  return EXTERNAL_TOOL_ICONS[name.toLowerCase()] ?? ExternalLink;
}
