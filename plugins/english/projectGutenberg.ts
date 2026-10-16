import { fetchApi, fetchText } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { Filters, FilterTypes } from '@libs/filterInputs';
import { defaultCover } from '@libs/defaultCover';
import { NovelStatus } from '@libs/novelStatus';
import { load as loadCheerio } from 'cheerio';

class ProjectGutenberg implements Plugin.PluginBase {
  id = 'projectgutenberg';
  name = 'Project Gutenberg';
  version = '1.0.2';
  icon = 'src/en/projectgutenberg/icon.png';
  site = 'https://www.gutenberg.org';
  filters = {
    topic: {
      label: 'Topic',
      value: '',
      options: [
        { label: 'All', value: '' },
        { label: 'Horror', value: 'horror' },
        { label: 'Science Fiction', value: 'science fiction' },
        { label: 'Fantasy', value: 'fantasy' },
        { label: 'Mystery', value: 'mystery' },
        { label: 'Adventure', value: 'adventure' },
        { label: 'Romance', value: 'romance' },
        { label: 'Children', value: 'children' },
      ],
      type: FilterTypes.Picker,
    },
  } satisfies Filters;

  private baseApi = 'https://gutendex.com';

  private bookToNovelItem(book: any): Plugin.NovelItem {
    const cover =
      book.formats?.['image/jpeg'] ||
      `https://www.gutenberg.org/cache/epub/${book.id}/pg${book.id}.cover.medium.jpg` ||
      defaultCover;
    return {
      name: book.title || 'Untitled',
      path: String(book.id),
      cover,
    };
  }

  private async fetchBooks(params: URLSearchParams): Promise<Plugin.NovelItem[]> {
    const url = `${this.baseApi}/books/?${params.toString()}`;
    try {
      const res = await fetchApi(url);
      if (!res.ok) return [];
      const text = await res.text();
      // Sometimes Gutendex returns non-JSON when overloaded
      if (!text.trim().startsWith('{')) return [];
      const data = JSON.parse(text);
      return (data.results || []).map((b: any) => this.bookToNovelItem(b));
    } catch (e) {
      console.error('Gutendex error:', e);
      return [];
    }
  }

  async popularNovels(
    page: number,
    { filters }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    const params = new URLSearchParams({
      languages: 'en',
      page: String(page),
      copyright: 'false',
    });
    if (filters?.topic?.value) {
      params.set('topic', filters.topic.value);
    }
    return this.fetchBooks(params);
  }

  async searchNovels(searchTerm: string, page: number): Promise<Plugin.NovelItem[]> {
    if (!searchTerm || !searchTerm.trim()) {
      return this.popularNovels(page, { filters: this.filters as any });
    }
    const params = new URLSearchParams({
      search: searchTerm.trim(),
      languages: 'en',
      page: String(page),
      copyright: 'false',
    });
    return this.fetchBooks(params);
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const id = novelPath.replace(/^\//, '');
    const res = await fetchApi(`${this.baseApi}/books/${id}`);
    if (!res.ok) throw new Error(`Book not found (${res.status})`);
    const book = await res.json();

    const authors = (book.authors || []).map((a: any) => a.name).join(', ');
    const subjects = (book.subjects || []).slice(0, 6).join(', ');
    const summary =
      (book.summaries && book.summaries[0]) ||
      `Public domain book from Project Gutenberg (ID ${book.id})`;

    const cover =
      book.formats?.['image/jpeg'] ||
      `https://www.gutenberg.org/cache/epub/${book.id}/pg${book.id}.cover.medium.jpg` ||
      defaultCover;

    // Prefer plain text – much faster to download and parse
    const hasTxt =
      book.formats?.['text/plain; charset=utf-8'] ||
      book.formats?.['text/plain; charset=us-ascii'] ||
      book.formats?.['text/plain'];
    const chapterPath = hasTxt ? `txt/${id}` : `html/${id}`;

    return {
      path: novelPath,
      name: book.title,
      author: authors || 'Unknown',
      cover,
      genres: subjects,
      status: NovelStatus.Completed,
      summary,
      chapters: [
        {
          name: 'Full Text',
          path: chapterPath,
          chapterNumber: 1,
        },
      ],
    };
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const [kind, id] = chapterPath.split('/');
    if (!id) return '<p>Invalid chapter</p>';

    const metaRes = await fetchApi(`${this.baseApi}/books/${id}`);
    const book = await metaRes.json();

    if (kind === 'txt') {
      const txtUrl =
        book.formats?.['text/plain; charset=utf-8'] ||
        book.formats?.['text/plain; charset=us-ascii'] ||
        book.formats?.['text/plain'] ||
        `https://www.gutenberg.org/files/${id}/${id}-0.txt`;

      let text = await fetchText(txtUrl);

      // Strip Gutenberg header/footer
      const startMarkers = [
        '*** START OF THE PROJECT GUTENBERG EBOOK',
        '*** START OF THIS PROJECT GUTENBERG EBOOK',
        '***START OF THE PROJECT GUTENBERG EBOOK',
      ];
      const endMarkers = [
        '*** END OF THE PROJECT GUTENBERG EBOOK',
        '*** END OF THIS PROJECT GUTENBERG EBOOK',
        '***END OF THE PROJECT GUTENBERG EBOOK',
      ];

      for (const m of startMarkers) {
        const idx = text.indexOf(m);
        if (idx !== -1) {
          text = text.slice(idx);
          const nl = text.indexOf('\n');
          if (nl !== -1) text = text.slice(nl + 1);
          break;
        }
      }
      for (const m of endMarkers) {
        const idx = text.indexOf(m);
        if (idx !== -1) {
          text = text.slice(0, idx);
          break;
        }
      }

      return text
        .split(/\n\s*\n/)
        .map(p => p.trim().replace(/\n/g, ' '))
        .filter(Boolean)
        .map(p => `<p>${p}</p>`)
        .join('\n') || '<p>Empty text</p>';
    }

    // HTML fallback
    const htmlUrl =
      book.formats?.['text/html'] ||
      book.formats?.['text/html; charset=utf-8'] ||
      `https://www.gutenberg.org/cache/epub/${id}/pg${id}-images.html`;
    const html = await fetchText(htmlUrl);
    const $ = loadCheerio(html);
    $('#pg-header, #pg-footer, .pg-boilerplate, #pg-machine-header').remove();
    $('[id^="pg-"]').remove();
    return $('body').html() || '<p>Unable to load</p>';
  }

  resolveUrl = (path: string, isNovel?: boolean) => {
    if (isNovel) return `${this.site}/ebooks/${path}`;
    return `${this.site}/ebooks/${path.split('/').pop()}`;
  };
}

export default new ProjectGutenberg();
