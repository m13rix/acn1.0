import React from 'react';

interface LayoutProps {
  children: React.ReactNode;
  sidebar?: React.ReactNode;
}

export const Layout: React.FC<LayoutProps> = ({ children, sidebar }) => {
  return (
    <div className="flex h-screen w-full bg-background text-foreground overflow-hidden font-sans selection:bg-white/20">
      {sidebar}
      <main className="flex-1 relative h-full flex flex-col min-w-0">
        {children}
      </main>
    </div>
  );
};
