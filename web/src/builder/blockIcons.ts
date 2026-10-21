import {
  AppWindow, BadgeCheck, BadgeDollarSign, Blocks, GalleryHorizontal, MessageSquareHeart, Star, CalendarClock, CircleHelp, Code, Columns2, Columns3, Columns4, GaugeCircle, Heading1, Heading3, Image, LayoutGrid, Link, List, ListOrdered,
  Mail, Megaphone, MessageSquare, MessageSquareQuote, Minus, MousePointerClick, Move, MoveVertical, Navigation, PackagePlus, PanelBottom, PanelLeft, PanelRight, PanelTop, PanelTopOpen,
  PanelsTopLeft, Pilcrow, Quote, RectangleHorizontal, Rows3, ShoppingCart, Sparkles, Square, SquareMousePointer, Tag, Timer, Video, Zap, type LucideIcon,
} from 'lucide-react';

/** Block icons by the name used in the block library (explicit imports keep the lazy builder chunk small). */
export const BLOCK_ICONS: Record<string, LucideIcon> = {
  BadgeCheck, GalleryHorizontal, MessageSquareHeart, Star, AppWindow, BadgeDollarSign, CalendarClock, CircleHelp, Code, Columns2, Columns3, Columns4, GaugeCircle, Heading1, Heading3, Image, LayoutGrid, Link, List, ListOrdered, Mail, Megaphone,
  MessageSquare, MessageSquareQuote, Minus, MousePointerClick, Move, MoveVertical, Navigation, PackagePlus, PanelBottom, PanelLeft, PanelRight, PanelTop, PanelTopOpen, PanelsTopLeft, Pilcrow,
  Quote, RectangleHorizontal, Rows3, ShoppingCart, Sparkles, Square, SquareMousePointer, Tag, Timer, Video, Zap,
};
export const blockIcon = (name: string): LucideIcon => BLOCK_ICONS[name] ?? Blocks;
