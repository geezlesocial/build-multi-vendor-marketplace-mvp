import React, { useEffect, useState } from 'react';
import './AdminCatalog.css';

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
  const response = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(options.headers ?? {}) }, ...options });
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error ?? 'Catalog request failed'); }
  return response.status === 204 ? undefined as T : response.json();
}

type Category = { id: string; name: string; slug: string; parentId: string | null; status: string; displayOrder: number; _count?: { products: number; children: number } };
type Brand = { id: string; name: string; slug: string; status: string; _count?: { products: number } };
type ProductType = { id: string; name: string; slug: string; description: string | null; requiresShipping: boolean; status: string; displayOrder: number; _count: { products: number; features: number } };
type Feature = { id: string; name: string; slug: string; status: string; categoryId: string | null; productTypeId: string | null; displayOrder: number; category: { id: string; name: string } | null; productType: { id: string; name: string } | null; _count: { products: number } };
type Suggestion = { id: string; kind: string; name: string; status: string; createdAt: string; parentCategory: { id: string; name: string } | null; featureCategory: { id: string; name: string } | null; submittedBy: { id: string; name: string; email: string } };
type EntityKind = 'category' | 'brand' | 'productType' | 'feature';
type EditState = { kind: EntityKind; id: string };
type EditValues = Record<string, string | number | boolean>;

export function AdminCatalog() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [productTypes, setProductTypes] = useState<ProductType[]>([]);
  const [features, setFeatures] = useState<Feature[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [categoryForm, setCategoryForm] = useState({ name: '', slug: '', parentId: '' });
  const [brandForm, setBrandForm] = useState({ name: '', slug: '' });
  const [featureForm, setFeatureForm] = useState({ name: '', categoryId: '', productTypeId: '' });
  const [productTypeForm, setProductTypeForm] = useState({ name: '', slug: '', description: '', requiresShipping: true, displayOrder: 0 });
  const [message, setMessage] = useState('');
  const [busyId, setBusyId] = useState('');
  const [editing, setEditing] = useState<EditState | null>(null);
  const [editForm, setEditForm] = useState<EditValues>({});

  const load = async () => {
    const [nextCategories, nextBrands, nextFeatures, nextTypes, nextSuggestions] = await Promise.all([
      api<Category[]>('/api/admin/categories'), api<Brand[]>('/api/admin/brands'),
      api<Feature[]>('/api/admin/catalog/features'), api<ProductType[]>('/api/admin/catalog/product-types'),
      api<Suggestion[]>('/api/admin/catalog/suggestions?status=PENDING')
    ]);
    setCategories(nextCategories); setBrands(nextBrands); setFeatures(nextFeatures); setProductTypes(nextTypes); setSuggestions(nextSuggestions);
  };
  useEffect(() => { void load().catch(error => setMessage((error as Error).message)); }, []);

  const save = async (work: () => Promise<unknown>, success: string) => {
    setMessage('');
    try { await work(); await load(); setMessage(success); return true; }
    catch (error) { setMessage((error as Error).message); return false; }
  };
  const categoryLabel = (category: Category) => {
    const parent = categories.find(item => item.id === category.parentId);
    return parent ? `${parent.name} / ${category.name}` : category.name;
  };
  const categoryDepth = (category: Category) => {
    let depth = 1;
    let parentId = category.parentId;
    while (parentId && depth <= 3) { const parent = categories.find(item => item.id === parentId); if (!parent) break; depth += 1; parentId = parent.parentId; }
    return depth;
  };
  const validParents = categories.filter(category => category.status === 'ACTIVE' && categoryDepth(category) < 3);
  const beginEdit = (kind: EntityKind, item: any) => {
    setEditing({ kind, id: item.id });
    setEditForm({ name: item.name, slug: item.slug, description: item.description ?? '', parentId: item.parentId ?? '', categoryId: item.categoryId ?? '', productTypeId: item.productTypeId ?? '', displayOrder: item.displayOrder ?? 0, requiresShipping: item.requiresShipping ?? true, status: item.status });
  };
  const endpoints: Record<EntityKind, string> = { category: '/api/admin/categories', brand: '/api/admin/brands', productType: '/api/admin/catalog/product-types', feature: '/api/admin/catalog/features' };
  const saveEdit = async () => {
    if (!editing) return;
    const body = { ...editForm,
      ...(editing.kind === 'category' ? { parentId: editForm.parentId || null } : {}),
      ...(editing.kind === 'feature' ? { categoryId: editForm.categoryId || null, productTypeId: editForm.productTypeId || null } : {}),
      ...(editing.kind === 'productType' ? { description: editForm.description || null } : {})
    };
    const saved = await save(() => api(`${endpoints[editing.kind]}/${encodeURIComponent(editing.id)}`, { method: 'PATCH', body: JSON.stringify(body) }), 'Catalog item updated.');
    if (saved) setEditing(null);
  };
  const deleteItem = async (kind: EntityKind, id: string, name: string) => {
    if (!window.confirm(`Delete “${name}”? Referenced catalog items are protected from deletion.`)) return;
    await save(() => api(`${endpoints[kind]}/${encodeURIComponent(id)}`, { method: 'DELETE' }), `${name} deleted.`);
  };
  const changeStatus = async (kind: EntityKind, item: { id: string }, status: string) => {
    const path = kind === 'feature' ? `${endpoints.feature}/${encodeURIComponent(item.id)}/status` : `${endpoints[kind]}/${encodeURIComponent(item.id)}`;
    await save(() => api(path, { method: 'PATCH', body: JSON.stringify({ status }) }), 'Catalog status updated.');
  };
  const review = async (item: Suggestion, decision: 'APPROVE' | 'REJECT') => {
    const reviewNote = decision === 'REJECT' ? window.prompt('Optional review note for the submitter') ?? '' : '';
    setBusyId(item.id);
    await save(() => api(`/api/admin/catalog/suggestions/${encodeURIComponent(item.id)}/review`, { method: 'POST', body: JSON.stringify({ decision, ...(reviewNote ? { reviewNote } : {}) }) }), decision === 'APPROVE' ? 'Suggestion approved and added to the active catalog.' : 'Suggestion rejected.');
    setBusyId('');
  };
  const editField = (name: string, label: string, options?: { type?: string; choices?: Array<{ value: string; label: string }> }) => <label key={name}>{label}{options?.choices ? <select value={String(editForm[name] ?? '')} onChange={event => setEditForm(current => ({ ...current, [name]: event.target.value }))}>{options.choices.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : <input type={options?.type ?? 'text'} value={String(editForm[name] ?? '')} onChange={event => setEditForm(current => ({ ...current, [name]: options?.type === 'number' ? Number(event.target.value) : event.target.value }))} />}</label>;
  const editActions = <div className="catalogReviewActions"><button type="button" onClick={() => void saveEdit()}>Save</button><button type="button" onClick={() => setEditing(null)}>Cancel</button></div>;
  const rowActions = (kind: EntityKind, item: { id: string; name: string; status: string }) => <div className="catalogReviewActions"><button type="button" onClick={() => beginEdit(kind, item)}>Edit</button>{item.status === 'ACTIVE' ? <button type="button" onClick={() => void changeStatus(kind, item, 'INACTIVE')}>Deactivate</button> : <button type="button" onClick={() => void changeStatus(kind, item, 'ACTIVE')}>Activate</button>}<button type="button" onClick={() => void deleteItem(kind, item.id, item.name)}>Delete</button></div>;

  return <section className="adminCatalog">
    <h2>Catalog &amp; categories</h2>
    <p className="muted">Manage product types, category hierarchy, brands, and type/category-specific features. Deactivation hides an item from new listings; referenced records are protected from deletion.</p>
    {message && <p role="status" className="notice">{message}</p>}

    <div className="adminCatalogForms">
      <form className="setting" onSubmit={event => { event.preventDefault(); void save(() => api('/api/admin/categories', { method: 'POST', body: JSON.stringify({ ...categoryForm, parentId: categoryForm.parentId || null }) }), 'Category created.').then(saved => { if (saved) setCategoryForm({ name: '', slug: '', parentId: '' }); }); }}>
        <h3>Add category</h3><label>Name<input required minLength={2} maxLength={120} value={categoryForm.name} onChange={event => setCategoryForm({ ...categoryForm, name: event.target.value })} /></label><label>URL slug<input required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" value={categoryForm.slug} onChange={event => setCategoryForm({ ...categoryForm, slug: event.target.value })} /></label><label>Parent category<select value={categoryForm.parentId} onChange={event => setCategoryForm({ ...categoryForm, parentId: event.target.value })}><option value="">Top-level category</option>{validParents.map(category => <option key={category.id} value={category.id}>{categoryLabel(category)}</option>)}</select></label><button className="primary">Create category</button>
      </form>
      <form className="setting" onSubmit={event => { event.preventDefault(); void save(() => api('/api/admin/brands', { method: 'POST', body: JSON.stringify(brandForm) }), 'Brand created.').then(saved => { if (saved) setBrandForm({ name: '', slug: '' }); }); }}>
        <h3>Add brand</h3><label>Name<input required minLength={2} maxLength={120} value={brandForm.name} onChange={event => setBrandForm({ ...brandForm, name: event.target.value })} /></label><label>URL slug<input required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" value={brandForm.slug} onChange={event => setBrandForm({ ...brandForm, slug: event.target.value })} /></label><button className="primary">Create brand</button>
      </form>
      <form className="setting" onSubmit={event => { event.preventDefault(); void save(() => api('/api/admin/catalog/product-types', { method: 'POST', body: JSON.stringify({ ...productTypeForm, description: productTypeForm.description || null }) }), 'Product type created.').then(saved => { if (saved) setProductTypeForm({ name: '', slug: '', description: '', requiresShipping: true, displayOrder: productTypes.length * 10 }); }); }}>
        <h3>Add product type</h3><label>Name<input required minLength={2} maxLength={120} value={productTypeForm.name} onChange={event => setProductTypeForm({ ...productTypeForm, name: event.target.value })} /></label><label>URL slug<input required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" value={productTypeForm.slug} onChange={event => setProductTypeForm({ ...productTypeForm, slug: event.target.value })} /></label><label>Description<input maxLength={500} value={productTypeForm.description} onChange={event => setProductTypeForm({ ...productTypeForm, description: event.target.value })} /></label><label>Display order<input type="number" min="0" max="100000" value={productTypeForm.displayOrder} onChange={event => setProductTypeForm({ ...productTypeForm, displayOrder: Number(event.target.value) })} /></label><label className="adminCatalogCheckbox"><input type="checkbox" checked={productTypeForm.requiresShipping} onChange={event => setProductTypeForm({ ...productTypeForm, requiresShipping: event.target.checked })} />Requires shipping</label><button className="primary">Create product type</button>
      </form>
      <form className="setting" onSubmit={event => { event.preventDefault(); void save(() => api('/api/admin/catalog/features', { method: 'POST', body: JSON.stringify({ name: featureForm.name, categoryId: featureForm.categoryId || null, productTypeId: featureForm.productTypeId || null }) }), 'Product feature created.').then(saved => { if (saved) setFeatureForm({ name: '', categoryId: '', productTypeId: '' }); }); }}>
        <h3>Add feature</h3><label>Name<input required minLength={2} maxLength={120} value={featureForm.name} onChange={event => setFeatureForm({ ...featureForm, name: event.target.value })} /></label><label>Product type scope<select value={featureForm.productTypeId} onChange={event => setFeatureForm({ ...featureForm, productTypeId: event.target.value })}><option value="">All product types</option>{productTypes.filter(type => type.status === 'ACTIVE').map(type => <option key={type.id} value={type.id}>{type.name}</option>)}</select></label><label>Category scope<select value={featureForm.categoryId} onChange={event => setFeatureForm({ ...featureForm, categoryId: event.target.value })}><option value="">All categories</option>{categories.filter(category => category.status === 'ACTIVE').map(category => <option key={category.id} value={category.id}>{categoryLabel(category)}</option>)}</select></label><button className="primary">Create feature</button>
      </form>
    </div>

    <h3>Pending catalog suggestions <span className="catalogCount">{suggestions.length}</span></h3>
    {suggestions.length ? <div className="catalogReviewList">{suggestions.map(item => <article className="setting catalogReviewItem" key={item.id}><div><p className="eyebrow">{item.kind.replace('_', ' ')}</p><strong>{item.name}</strong><p className="muted">{item.kind === 'CHILD_CATEGORY' ? `Under ${item.parentCategory?.name ?? 'missing parent'}` : item.kind === 'FEATURE' ? `For ${item.featureCategory?.name ?? 'all categories'}` : 'Marketplace-wide'} · Suggested by {item.submittedBy.name || item.submittedBy.email} · {new Date(item.createdAt).toLocaleDateString()}</p></div><div className="catalogReviewActions"><button type="button" disabled={busyId === item.id} onClick={() => void review(item, 'APPROVE')}>Approve</button><button type="button" disabled={busyId === item.id} onClick={() => void review(item, 'REJECT')}>Reject</button></div></article>)}</div> : <div className="empty">No catalog suggestions are waiting for review.</div>}

    <h3>Product types</h3><div className="table adminCatalogList">{productTypes.map(type => <article className="adminCatalogRow" key={type.id}>{editing?.kind === 'productType' && editing.id === type.id ? <div className="adminCatalogEdit">{editField('name', 'Name')}{editField('slug', 'Slug')}{editField('description', 'Description')}{editField('displayOrder', 'Display order', { type: 'number' })}{editField('status', 'Status', { choices: ['ACTIVE', 'INACTIVE', 'ARCHIVED'].map(value => ({ value, label: value })) })}<label className="adminCatalogCheckbox"><input type="checkbox" checked={Boolean(editForm.requiresShipping)} onChange={event => setEditForm(current => ({ ...current, requiresShipping: event.target.checked }))} />Requires shipping</label>{editActions}</div> : <><div><strong>{type.name}</strong><p className="muted">{type.slug} · {type.requiresShipping ? 'Requires shipping' : 'No shipping'} · {type._count.products} products · {type._count.features} features</p></div><strong>{type.status}</strong>{rowActions('productType', type)}</>}</article>)}</div>

    <h3>Categories and child categories</h3><div className="table adminCatalogList">{categories.map(category => <article className="adminCatalogRow" key={category.id}>{editing?.kind === 'category' && editing.id === category.id ? <div className="adminCatalogEdit">{editField('name', 'Name')}{editField('slug', 'Slug')}<label>Parent category<select value={String(editForm.parentId)} onChange={event => setEditForm(current => ({ ...current, parentId: event.target.value }))}><option value="">Top-level category</option>{validParents.filter(parent => parent.id !== category.id).map(parent => <option key={parent.id} value={parent.id}>{categoryLabel(parent)}</option>)}</select></label>{editField('status', 'Status', { choices: ['ACTIVE', 'INACTIVE', 'ARCHIVED'].map(value => ({ value, label: value })) })}{editField('displayOrder', 'Display order', { type: 'number' })}{editActions}</div> : <><div><strong>{categoryLabel(category)}</strong><p className="muted">{category.parentId ? 'Child category' : 'Top-level category'} · {category.slug} · {category._count?.products ?? 0} products · {category._count?.children ?? 0} children</p></div><strong>{category.status}</strong>{rowActions('category', category)}</>}</article>)}</div>

    <h3>Brands</h3><div className="table adminCatalogList">{brands.map(brand => <article className="adminCatalogRow" key={brand.id}>{editing?.kind === 'brand' && editing.id === brand.id ? <div className="adminCatalogEdit">{editField('name', 'Name')}{editField('slug', 'Slug')}{editField('status', 'Status', { choices: ['ACTIVE', 'INACTIVE', 'ARCHIVED'].map(value => ({ value, label: value })) })}{editActions}</div> : <><div><strong>{brand.name}</strong><p className="muted">{brand.slug} · {brand._count?.products ?? 0} products</p></div><strong>{brand.status}</strong>{rowActions('brand', brand)}</>}</article>)}</div>

    <h3>Product features</h3><div className="table adminCatalogList">{features.map(feature => <article className="adminCatalogRow" key={feature.id}>{editing?.kind === 'feature' && editing.id === feature.id ? <div className="adminCatalogEdit">{editField('name', 'Name')}<label>Product type<select value={String(editForm.productTypeId)} onChange={event => setEditForm(current => ({ ...current, productTypeId: event.target.value }))}><option value="">All product types</option>{productTypes.filter(type => type.status === 'ACTIVE').map(type => <option key={type.id} value={type.id}>{type.name}</option>)}</select></label><label>Category<select value={String(editForm.categoryId)} onChange={event => setEditForm(current => ({ ...current, categoryId: event.target.value }))}><option value="">All categories</option>{categories.filter(category => category.status === 'ACTIVE').map(category => <option key={category.id} value={category.id}>{categoryLabel(category)}</option>)}</select></label>{editField('status', 'Status', { choices: ['ACTIVE', 'INACTIVE', 'ARCHIVED'].map(value => ({ value, label: value })) })}{editField('displayOrder', 'Display order', { type: 'number' })}{editActions}</div> : <><div><strong>{feature.name}</strong><p className="muted">{feature.productType?.name ?? 'All product types'} · {feature.category?.name ?? 'All categories'} · {feature._count.products} products</p></div><strong>{feature.status}</strong>{rowActions('feature', feature)}</>}</article>)}</div>
  </section>;
}
