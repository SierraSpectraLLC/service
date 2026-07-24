import { redirect } from "next/navigation";
import { asc, inArray } from "drizzle-orm";
import { db } from "@/db";
import { taskTemplates, templateTasks, templateItems } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import TemplatesPanel from "@/components/TemplatesPanel";

export const dynamic = "force-dynamic";

export default async function TemplatesPage() {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (user.role !== "owner" && user.role !== "staff") redirect("/");

  const tpls = await db.select().from(taskTemplates).orderBy(asc(taskTemplates.name));
  const tplIds = tpls.map((t) => t.id);
  const tTasks = tplIds.length
    ? await db.select().from(templateTasks).where(inArray(templateTasks.templateId, tplIds))
      .orderBy(asc(templateTasks.sortOrder), asc(templateTasks.id))
    : [];
  const taskIds = tTasks.map((t) => t.id);
  const tItems = taskIds.length
    ? await db.select().from(templateItems).where(inArray(templateItems.templateTaskId, taskIds))
      .orderBy(asc(templateItems.sortOrder), asc(templateItems.id))
    : [];

  const templates = tpls.map((t) => ({
    id: t.id,
    name: t.name,
    tasks: tTasks.filter((x) => x.templateId === t.id).map((x) => ({
      id: x.id, title: x.title, body: x.body,
      items: tItems.filter((i) => i.templateTaskId === x.id).map((i) => ({ id: i.id, text: i.text })),
    })),
  }));

  return (
    <div className="container" style={{ maxWidth: 720 }}>
      <TemplatesPanel templates={templates} />
    </div>
  );
}
