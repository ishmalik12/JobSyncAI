
import re

SKILLS = [
    "python", "java", "javascript", "typescript",
    "react", "html", "css", "fastapi", "django",
    "flask", "sql", "postgresql", "mysql",
    "mongodb", "pandas", "numpy", "scikit-learn",
    "machine learning", "deep learning",
    "natural language processing", "nlp",
    "excel", "statistics", "data analysis",
    "data visualization", "git", "rest apis",
    "docker", "tensorflow", "pytorch"
]

def extract_skills(text: str) -> list[str]:
    text = text.lower()
    found = []

    for skill in SKILLS:
        pattern = r"(?<!\w)" + re.escape(skill) + r"(?!\w)"

        if re.search(pattern, text):
            found.append(skill)

    return found
