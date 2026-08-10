# Pandora's Box - Writer's Studio

We're working to build an application for writing novels for the desktop.  It's also an AI harness for writers to use locally run LLMs or connect to remote LLMs like Claude or ChatGPT.  


## Functionality
- The primary editor should be a markdown editor with a markdown preview as well
- There should be a chat interface for interacting with the AI model
- Documents should be stored in the local filesystem, with a parent directory for the novel, with each chapter stored as a separate file, and subdirectories for storing summaries, character profiles, and other metadata about the novel.
  - If the novel is part of a series, we can use a higher level directory for the series and that will be where series metadata exists.
- We want to continuously be generating metadata that is useful for the author but mostly for the AI model to maintain better context about what's going on in the story.
  - For example, if our story is using a leveling system like in LitRPG, we need to store not just the character's stats and level information, but we need a document that maintains info about how the leveling system works, what tiers exist, breakthrough requirements, number of stats per level, etc.
  - Another example, if there are caharacter interactions, we need to store timelines and synopses of the story so the AI model can understand the context of the story.
- All metadata should be stored in a structured format so the AI model can easily parse and understand it.
- All metadata should be browseable and editable by the user so they can correct or update it as needed.
- Metadata should be stored on saving a chapter.
- There should be an option for the user to use LLMs to write a first draft of a chapter through chat.
- There should be an outlining capability for the user to interact with the AI model to outline the chapter or the whole novel or series.
