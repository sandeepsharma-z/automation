from app.services.pipeline.qa import run_draft_qa


def test_qa_catches_anchor_repetition():
    html = """
    <article>
      <h1>Test Draft</h1>
      <p>This draft talks about internal linking strategy in detail.</p>
      <p><a href='https://example.com/a'>Internal Link</a> and
         <a href='https://example.com/b'>Internal Link</a></p>
    </article>
    """
    candidates = [
        {'url': 'https://example.com/a', 'title': 'A'},
        {'url': 'https://example.com/b', 'title': 'B'},
        {'url': 'https://example.com/c', 'title': 'C'},
    ]

    qa = run_draft_qa(html, candidates)

    assert qa['passed'] is False
    assert any('Anchor repetition' in warning for warning in qa['warnings'])


def test_qa_strictness_affects_readability_threshold():
    long_text = ' '.join(['Short sentence for readability.'] * 80)
    html = """
    <article>
      <h1>Readable Draft</h1>
      <p>{long_text}</p>
      <p><a href='https://example.com/a'>Guide A</a></p>
    </article>
    """.format(long_text=long_text)
    candidates = [{'url': 'https://example.com/a', 'title': 'A'}]

    low = run_draft_qa(html, candidates, strictness='low', internal_links_max=5)
    high = run_draft_qa(
        html.replace(long_text, 'short text only'),
        candidates,
        strictness='high',
        internal_links_max=5,
    )

    assert low['passed'] is True
    assert high['passed'] is False
